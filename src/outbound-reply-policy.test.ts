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

test('suppresses duplicates even when casing differs', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('Morning Engel Paws', [
      { kind: 'current_thread_message', text: 'morning engel paws' },
    ]),
    false,
  );
});

test('does not suppress when final reply is only a substring of outbound text', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('All set.', [
      { kind: 'current_thread_message', text: 'All set. The den is tidy.' },
    ]),
    true,
  );
});

test('does not suppress short substring false positives', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('in', [
      { kind: 'current_thread_message', text: 'Winning the den cleanup race.' },
    ]),
    true,
  );
});

test('suppresses short lead-in only when outbound starts with that lead-in', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('Summary:', [
      { kind: 'current_thread_message', text: 'Summary: 1) paws 2) treats' },
    ]),
    false,
  );
});

test('does not suppress short lead-in when outbound only mentions it later', () => {
  assert.equal(
    shouldSendFinalReplyAfterOutbound('Summary:', [
      { kind: 'current_thread_message', text: 'Quick note before the Summary: 1) paws 2) treats' },
    ]),
    true,
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
