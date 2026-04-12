import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSendFinalReplyAfterOutbound } from './outbound-reply-policy.js';

test('sends a final reply when there are no outbound messages', () => {
  assert.equal(shouldSendFinalReplyAfterOutbound('final reply', undefined), true);
});

test('suppresses a final reply duplicated by the last outbound message', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('Morning Engel paws', [
      { kind: 'current_thread_message', text: 'Morning Engel paws' },
    ]),
    false,
  );
});

test('suppresses duplicates even when spacing differs', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('Let me check that for you.', [
      { kind: 'current_thread_message', text: '  Let me   check that for you.  ' },
    ]),
    false,
  );
});

test('still sends a distinct final reply after outbound progress updates', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('All set. The den is tidy.', [
      { kind: 'current_thread_message', text: 'Still checking the den...' },
    ]),
    true,
  );
});
