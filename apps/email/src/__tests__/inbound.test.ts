import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationId,
  buildEmailPrompt,
  decideAllowlist,
  parseAllowedSenders,
  parseEmailAddress,
} from '../inbound.js';

test('parseEmailAddress handles display names, angle brackets, and plain', () => {
  assert.equal(parseEmailAddress('Engel Nyst <engel@enyst.org>'), 'engel@enyst.org');
  assert.equal(parseEmailAddress('<engel@enyst.org>'), 'engel@enyst.org');
  assert.equal(parseEmailAddress('engel@enyst.org'), 'engel@enyst.org');
  assert.equal(parseEmailAddress('  ENGEL@Enyst.ORG '), 'engel@enyst.org');
});

test('parseEmailAddress rejects non-addresses', () => {
  assert.equal(parseEmailAddress(''), '');
  assert.equal(parseEmailAddress(null), '');
  assert.equal(parseEmailAddress('not an email'), '');
  assert.equal(parseEmailAddress('Name <garbage>'), '');
});

test('parseAllowedSenders normalizes a comma list', () => {
  const set = parseAllowedSenders('engel.nyst@gmail.com, Engel <engel@enyst.org> , anarresian@icloud.com');
  assert.ok(set.has('engel.nyst@gmail.com'));
  assert.ok(set.has('engel@enyst.org'));
  assert.ok(set.has('anarresian@icloud.com'));
  assert.equal(set.size, 3);
});

test('decideAllowlist allows only listed senders (case-insensitive)', () => {
  const allowed = parseAllowedSenders('engel@enyst.org');
  assert.equal(decideAllowlist('Engel <ENGEL@enyst.org>', allowed).allowed, true);
  assert.equal(decideAllowlist('stranger@evil.com', allowed).reason, 'sender_not_allowed');
});

test('decideAllowlist fails closed on empty allowlist', () => {
  const decision = decideAllowlist('engel@enyst.org', new Set());
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'empty_allowlist');
});

test('decideAllowlist rejects unparseable senders', () => {
  const allowed = parseAllowedSenders('engel@enyst.org');
  const decision = decideAllowlist('garbage', allowed);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'unparseable_sender');
});

test('buildConversationId is stable and slugged per sender', () => {
  assert.equal(buildConversationId('engel.nyst@gmail.com'), 'email-engel-nyst-gmail-com');
  assert.equal(
    buildConversationId('engel.nyst@gmail.com'),
    buildConversationId('ENGEL.NYST@GMAIL.COM'),
  );
});

test('buildEmailPrompt delimits untrusted body and includes subject/sender', () => {
  const prompt = buildEmailPrompt({
    from: 'engel@enyst.org',
    subject: 'hello',
    text: 'do a thing',
  });
  assert.match(prompt, /from engel@enyst\.org/);
  assert.match(prompt, /Subject: hello/);
  assert.match(prompt, /untrusted content/);
  assert.match(prompt, /do a thing/);
});

test('buildEmailPrompt tolerates empty subject and body', () => {
  const prompt = buildEmailPrompt({ from: 'engel@enyst.org' });
  assert.match(prompt, /\(no subject\)/);
  assert.match(prompt, /\(empty body\)/);
});
