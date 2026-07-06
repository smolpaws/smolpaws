/**
 * Minimal Resend REST client for the inbound email bridge.
 *
 * - `retrieveReceivedEmail` fetches full inbound content (webhooks carry only
 *   metadata, so we must GET the body by `email_id`).
 * - `sendEmail` delivers the agent's reply back through Resend, threading it
 *   onto the original message via In-Reply-To / References.
 */

const RESEND_API_BASE = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 15_000;

export type ReceivedEmail = {
  id: string;
  from: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string | null;
  message_id?: string;
  headers?: Record<string, unknown>;
};

export async function retrieveReceivedEmail(options: {
  apiKey: string;
  emailId: string;
  fetchImpl?: typeof fetch;
}): Promise<ReceivedEmail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resp = await fetchImpl(
    `${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(options.emailId)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`retrieveReceivedEmail failed: ${resp.status} ${body}`);
  }
  return (await resp.json()) as ReceivedEmail;
}

export async function sendEmail(options: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (options.inReplyTo) headers['In-Reply-To'] = options.inReplyTo;
  if (options.references) headers['References'] = options.references;

  const resp = await fetchImpl(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      from: options.from,
      to: [options.to],
      subject: options.subject,
      text: options.text,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`sendEmail failed: ${resp.status} ${body}`);
  }
  return (await resp.json()) as { id: string };
}

/** Build a threaded reply subject: prefix `Re:` unless already present. */
export function buildReplySubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  if (!s) return 'Re: (no subject)';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
