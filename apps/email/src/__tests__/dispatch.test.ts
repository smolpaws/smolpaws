import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmailReplyBody } from '../agentDispatch.js';
import { buildReplySubject } from '../resendClient.js';

test('resolveEmailReplyBody returns undefined for null result', () => {
  assert.equal(resolveEmailReplyBody(null), undefined);
});

test('resolveEmailReplyBody joins outbound thread messages', () => {
  const body = resolveEmailReplyBody({
    reply: 'final',
    outbound_messages: [
      { kind: 'current_thread_message', text: 'part one' },
      { kind: 'current_thread_message', text: 'part two' },
    ],
  });
  assert.equal(body, 'part one\n\npart two');
});

test('resolveEmailReplyBody falls back to final reply when no outbound', () => {
  const body = resolveEmailReplyBody({ reply: 'the answer', outbound_messages: [] });
  assert.equal(body, 'the answer');
});

test('resolveEmailReplyBody returns undefined when nothing to say', () => {
  assert.equal(resolveEmailReplyBody({ reply: '', outbound_messages: [] }), undefined);
});

test('buildReplySubject prefixes Re: and avoids double prefix', () => {
  assert.equal(buildReplySubject('hello'), 'Re: hello');
  assert.equal(buildReplySubject('Re: hello'), 'Re: hello');
  assert.equal(buildReplySubject('RE: hello'), 'RE: hello');
  assert.equal(buildReplySubject(''), 'Re: (no subject)');
  assert.equal(buildReplySubject(undefined), 'Re: (no subject)');
});
