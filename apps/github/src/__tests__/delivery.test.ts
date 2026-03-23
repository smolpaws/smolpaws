import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPostReplyAfterOutbound } from '../index.js';

test('shouldPostReplyAfterOutbound posts the final reply after progress outbound messages', () => {
  assert.equal(
    shouldPostReplyAfterOutbound('final answer', [
      { kind: 'current_thread_message', text: 'Let me check that for you.' },
    ]),
    true,
  );
});

test('shouldPostReplyAfterOutbound suppresses duplicate final replies', () => {
  assert.equal(
    shouldPostReplyAfterOutbound('Let me check that for you.', [
      { kind: 'current_thread_message', text: ' Let me   check that for you. ' },
    ]),
    false,
  );
});
