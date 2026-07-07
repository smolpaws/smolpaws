import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInboundAuth, domainOf, getHeader, parseDmarc } from '../authcheck.js';

// Real header shape captured from an SES→Resend inbound (gmail sender).
const GMAIL_AUTH_RESULTS =
  'amazonses.com; spf=pass (spfCheck: domain of _spf.google.com designates 209.85.219.46 as permitted sender) client-ip=209.85.219.46; envelope-from=engel.nyst@gmail.com; helo=mail-qv1-f46.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com;';

function gmailHeaders(overrides: Record<string, unknown> = {}) {
  return {
    'x-ses-spam-verdict': 'PASS',
    'x-ses-virus-verdict': 'PASS',
    'authentication-results': GMAIL_AUTH_RESULTS,
    from: '"Engel Nyst" <engel.nyst@gmail.com>',
    ...overrides,
  };
}

test('domainOf extracts the domain', () => {
  assert.equal(domainOf('engel.nyst@gmail.com'), 'gmail.com');
  assert.equal(domainOf('a@b@enyst.org'), 'enyst.org');
  assert.equal(domainOf('nope'), '');
  assert.equal(domainOf('trailing@'), '');
});

test('getHeader is case-insensitive and returns the first element of arrays', () => {
  assert.equal(getHeader({ 'X-SES-Spam-Verdict': 'PASS' }, 'x-ses-spam-verdict'), 'PASS');
  // First element only — never join (a sender-injected duplicate must not smuggle values).
  assert.equal(getHeader({ received: ['a', 'b'] }, 'received'), 'a');
  assert.equal(getHeader({ received: [] }, 'received'), '');
  assert.equal(getHeader(undefined, 'x'), '');
  assert.equal(getHeader({}, 'x'), '');
});

test('parseDmarc extracts result and aligned header.from', () => {
  const { result, headerFrom } = parseDmarc(GMAIL_AUTH_RESULTS);
  assert.equal(result, 'pass');
  assert.equal(headerFrom, 'gmail.com');
});

test('checkInboundAuth passes for an authenticated, aligned gmail message', () => {
  const v = checkInboundAuth({ headers: gmailHeaders(), senderDomain: 'gmail.com' });
  assert.equal(v.authenticated, true);
  assert.equal(v.reason, 'authenticated');
});

test('checkInboundAuth rejects when DMARC domain does not match the sender', () => {
  // dmarc=pass for gmail.com, but the allowlisted sender claims enyst.org →
  // this is the spoofing case the gate exists to catch.
  const v = checkInboundAuth({ headers: gmailHeaders(), senderDomain: 'enyst.org' });
  assert.equal(v.authenticated, false);
  assert.equal(v.reason, 'dmarc_domain_mismatch');
});

test('checkInboundAuth rejects dmarc=none / fail', () => {
  const none = checkInboundAuth({
    headers: gmailHeaders({ 'authentication-results': 'amazonses.com; spf=pass; dmarc=none header.from=spoof.com;' }),
    senderDomain: 'spoof.com',
  });
  assert.equal(none.authenticated, false);
  assert.equal(none.reason, 'dmarc_none');

  const fail = checkInboundAuth({
    headers: gmailHeaders({ 'authentication-results': 'amazonses.com; dmarc=fail header.from=gmail.com;' }),
    senderDomain: 'gmail.com',
  });
  assert.equal(fail.authenticated, false);
  assert.equal(fail.reason, 'dmarc_fail');
});

test('checkInboundAuth fails closed when authentication-results is missing', () => {
  const v = checkInboundAuth({
    headers: { 'x-ses-spam-verdict': 'PASS', 'x-ses-virus-verdict': 'PASS' },
    senderDomain: 'gmail.com',
  });
  assert.equal(v.authenticated, false);
  assert.equal(v.reason, 'no_authentication_results');
});

test('checkInboundAuth fails closed when spam/virus verdicts are absent', () => {
  const noSpam = checkInboundAuth({
    headers: { 'x-ses-virus-verdict': 'PASS', 'authentication-results': GMAIL_AUTH_RESULTS },
    senderDomain: 'gmail.com',
  });
  assert.equal(noSpam.authenticated, false);
  assert.equal(noSpam.reason, 'spam_verdict_missing');

  const noVirus = checkInboundAuth({
    headers: { 'x-ses-spam-verdict': 'PASS', 'authentication-results': GMAIL_AUTH_RESULTS },
    senderDomain: 'gmail.com',
  });
  assert.equal(noVirus.authenticated, false);
  assert.equal(noVirus.reason, 'virus_verdict_missing');
});

test('checkInboundAuth rejects a forged Authentication-Results (wrong authserv-id)', () => {
  // Sender injects their own A-R claiming dmarc=pass, but the authserv-id is
  // not our trusted receiving MTA.
  const v = checkInboundAuth({
    headers: gmailHeaders({
      'authentication-results': 'evil.example.com; spf=pass; dmarc=pass header.from=gmail.com;',
    }),
    senderDomain: 'gmail.com',
  });
  assert.equal(v.authenticated, false);
  assert.equal(v.reason, 'untrusted_authserv_id');
});

test('checkInboundAuth rejects spam/virus failures', () => {
  const spam = checkInboundAuth({
    headers: gmailHeaders({ 'x-ses-spam-verdict': 'FAIL' }),
    senderDomain: 'gmail.com',
  });
  assert.equal(spam.authenticated, false);
  assert.equal(spam.reason, 'spam_verdict_fail');

  const virus = checkInboundAuth({
    headers: gmailHeaders({ 'x-ses-virus-verdict': 'FAIL' }),
    senderDomain: 'gmail.com',
  });
  assert.equal(virus.authenticated, false);
  assert.equal(virus.reason, 'virus_verdict_fail');
});

test('checkInboundAuth fails closed with no headers at all', () => {
  const v = checkInboundAuth({ headers: undefined, senderDomain: 'gmail.com' });
  assert.equal(v.authenticated, false);
  // With no headers, the spam verdict is the first thing that fails closed.
  assert.equal(v.reason, 'spam_verdict_missing');
});
