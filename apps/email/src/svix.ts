/**
 * Svix webhook signature verification.
 *
 * Resend delivers webhooks through Svix. Every request carries three headers:
 *   - `svix-id`         — unique message id
 *   - `svix-timestamp`  — unix seconds when the message was sent
 *   - `svix-signature`  — space-delimited list of `v1,<base64sig>` entries
 *
 * The signed content is `${id}.${timestamp}.${body}`. The signature is an
 * HMAC-SHA256 of that content, keyed by the secret. The secret is delivered as
 * `whsec_<base64>`; the bytes after the prefix are the raw HMAC key.
 *
 * This module is pure (no I/O beyond WebCrypto) so it can be unit-tested.
 */

const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export type SvixVerifyResult = {
  valid: boolean;
  reason?: string;
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

/** Constant-time string comparison to avoid signature timing leaks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Decode a `whsec_...` secret into its raw HMAC key bytes. */
export function decodeSvixSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  const body = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;
  return base64ToBytes(body);
}

/**
 * Verify a Svix-signed webhook.
 *
 * Returns `{ valid: true }` only when the timestamp is within tolerance and at
 * least one supplied `v1` signature matches the computed HMAC.
 */
export async function verifySvixSignature(options: {
  secret: string;
  headers: SvixHeaders;
  body: string;
  nowSeconds?: number;
}): Promise<SvixVerifyResult> {
  const { secret, headers, body } = options;
  const { id, timestamp, signature } = headers;

  if (!id || !timestamp || !signature) {
    return { valid: false, reason: 'missing_svix_headers' };
  }

  // Strict: reject anything that isn't purely digits (parseInt would happily
  // accept "1700000000xyz").
  if (!/^\d+$/.test(timestamp.trim())) {
    return { valid: false, reason: 'invalid_timestamp' };
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVIX_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeSvixSecret(secret);
  } catch {
    return { valid: false, reason: 'invalid_secret' };
  }

  const encoder = new TextEncoder();
  const signedContent = `${id}.${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signedContent));
  const expected = bytesToBase64(digest);

  // Header is a space-delimited list of `version,signature` pairs.
  const provided = signature
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const entry of provided) {
    const commaIndex = entry.indexOf(',');
    const version = commaIndex >= 0 ? entry.slice(0, commaIndex) : '';
    const sig = commaIndex >= 0 ? entry.slice(commaIndex + 1) : entry;
    if (version === 'v1' && timingSafeEqual(sig, expected)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'no_matching_signature' };
}
