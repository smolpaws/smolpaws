import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQueueReplyBody, shouldPostReplyAfterOutbound } from '../index.js';

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


test('shouldPostReplyAfterOutbound suppresses short lead-in replies when outbound already contains the real answer', () => {
  assert.equal(
    shouldPostReplyAfterOutbound("Yes, I can see this PR! Here's my summary:", [
      {
        kind: 'current_thread_message',
        text: '**PR #42**\n\nFull summary follows in detail here.',
      },
    ]),
    false,
  );
});

test('resolveQueueReplyBody only emits the runner-not-configured fallback when the runner is absent', () => {
  assert.equal(
    resolveQueueReplyBody(null),
    '🐾 smolpaws heard you and is waking up. Runner is not configured yet.',
  );
  assert.equal(resolveQueueReplyBody({ reply: undefined, outbound_messages: undefined }), undefined);
});

test('resolveQueueReplyBody prefers real replies and stays quiet when outbound messages exist', () => {
  assert.equal(
    resolveQueueReplyBody({ reply: 'real reply', outbound_messages: undefined }),
    'real reply',
  );
  assert.equal(
    resolveQueueReplyBody({
      reply: undefined,
      outbound_messages: [{ kind: 'current_thread_message', text: 'progress update' }],
    }),
    undefined,
  );
});
