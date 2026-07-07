/**
 * Inbound email authentication gate.
 *
 * The webhook-time allowlist trusts the `From` address, but a raw `From:` can be
 * spoofed. This gate runs in the queue consumer *after* we fetch the full email
 * (with headers) and before we dispatch to the agent. It requires that the
 * upstream receiver (Amazon SES, in front of Resend) actually authenticated the
 * message:
 *
 *   - SES spam verdict PASS
 *   - SES virus verdict PASS
 *   - DMARC pass (this is the anti-spoofing check: DMARC requires the `From:`
 *     domain to be authenticated via SPF or DKIM *and aligned*)
 *   - the DMARC-evaluated `header.from` domain matches the allowlisted sender's
 *     domain (so a DMARC pass for some other domain can't vouch for this From)
 *
 * Fails closed: if any header is missing or unparseable, the message is not
 * authenticated. Pure/testable — takes a headers object, returns a verdict.
 */

export type InboundHeaders = Record<string, unknown>;

export type AuthVerdict = {
  authenticated: boolean;
  reason: string;
};

/** Case-insensitive header lookup returning a trimmed string, or ''. */
export function getHeader(headers: InboundHeaders | undefined, name: string): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      if (typeof v === 'string') return v.trim();
      if (Array.isArray(v)) return v.map((x) => String(x)).join(' ').trim();
      if (v == null) return '';
      return String(v).trim();
    }
  }
  return '';
}

/** Domain part of an email address, lowercased. '' if not an address. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return '';
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * Parse the DMARC result out of an SES `Authentication-Results` header.
 * Returns `{ result, headerFrom }` where result is e.g. 'pass'/'fail'/'none'
 * and headerFrom is the aligned domain (from `header.from=...`), both lowercased.
 */
export function parseDmarc(authResults: string): { result: string; headerFrom: string } {
  const result = /(?:^|;|\s)dmarc=([a-z]+)/i.exec(authResults)?.[1]?.toLowerCase() ?? '';
  const headerFrom = /dmarc=[a-z]+[^;]*?header\.from=([^\s;]+)/i
    .exec(authResults)?.[1]
    ?.trim()
    .toLowerCase() ?? '';
  return { result, headerFrom };
}

/**
 * Decide whether an inbound email is authenticated well enough to dispatch.
 * `senderDomain` is the domain of the already-allowlisted sender.
 */
export function checkInboundAuth(options: {
  headers: InboundHeaders | undefined;
  senderDomain: string;
}): AuthVerdict {
  const { headers, senderDomain } = options;

  const spam = getHeader(headers, 'x-ses-spam-verdict').toUpperCase();
  if (spam && spam !== 'PASS') {
    return { authenticated: false, reason: `spam_verdict_${spam.toLowerCase()}` };
  }

  const virus = getHeader(headers, 'x-ses-virus-verdict').toUpperCase();
  if (virus && virus !== 'PASS') {
    return { authenticated: false, reason: `virus_verdict_${virus.toLowerCase()}` };
  }

  const authResults = getHeader(headers, 'authentication-results');
  if (!authResults) {
    return { authenticated: false, reason: 'no_authentication_results' };
  }

  const { result, headerFrom } = parseDmarc(authResults);
  if (result !== 'pass') {
    return { authenticated: false, reason: `dmarc_${result || 'absent'}` };
  }

  // Alignment: the DMARC pass must be for the sender's own domain.
  if (!headerFrom) {
    return { authenticated: false, reason: 'dmarc_no_header_from' };
  }
  const sd = senderDomain.trim().toLowerCase();
  if (headerFrom !== sd) {
    return { authenticated: false, reason: 'dmarc_domain_mismatch' };
  }

  return { authenticated: true, reason: 'authenticated' };
}
