import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendOutboundMessage,
  claimOutboundMessages,
} from '../runner/outbox.js';
import { buildConversationDirPath } from '../runner/conversationService.js';

test('conversation-scoped claims keep turn-owned items isolated and preserve legacy queue items', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-outbox-'));
  const conversationId = 'outbox-compat-test';
  const conversationDir = buildConversationDirPath(conversationId, persistenceRoot);
  mkdirSync(conversationDir, { recursive: true });
  writeFileSync(
    path.join(conversationDir, 'outbox.jsonl'),
    [
      JSON.stringify({ kind: 'current_thread_message', text: 'legacy item' }),
      JSON.stringify({
        turn_id: 'turn-1',
        payload: { kind: 'current_thread_message', text: 'turn-owned item' },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    const legacyClaim = await claimOutboundMessages(conversationId, persistenceRoot);
    assert.deepEqual(legacyClaim, [
      { kind: 'current_thread_message', text: 'legacy item' },
    ]);

    const turnClaim = await claimOutboundMessages(conversationId, persistenceRoot, {
      turnId: 'turn-1',
    });
    assert.deepEqual(turnClaim, [
      { kind: 'current_thread_message', text: 'turn-owned item' },
    ]);
  } finally {
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

test('turn-scoped claims preserve concurrent appends and remaining items', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-outbox-'));
  const conversationId = 'outbox-race-test';

  try {
    await appendOutboundMessage(
      conversationId,
      persistenceRoot,
      { kind: 'current_thread_message', text: 'turn-1 item' },
      { turnId: 'turn-1' },
    );
    await appendOutboundMessage(
      conversationId,
      persistenceRoot,
      { kind: 'current_thread_message', text: 'turn-2 item' },
      { turnId: 'turn-2' },
    );

    const claimPromise = claimOutboundMessages(conversationId, persistenceRoot, {
      turnId: 'turn-1',
    });
    const appendPromise = appendOutboundMessage(
      conversationId,
      persistenceRoot,
      { kind: 'current_thread_message', text: 'late legacy item' },
    );

    const claimed = await claimPromise;
    await appendPromise;

    assert.deepEqual(claimed, [
      { kind: 'current_thread_message', text: 'turn-1 item' },
    ]);
    assert.deepEqual(
      await claimOutboundMessages(conversationId, persistenceRoot),
      [{ kind: 'current_thread_message', text: 'late legacy item' }],
    );
    assert.deepEqual(
      await claimOutboundMessages(conversationId, persistenceRoot, {
        turnId: 'turn-2',
      }),
      [{ kind: 'current_thread_message', text: 'turn-2 item' }],
    );
  } finally {
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

test('draining the final queue item leaves an empty queue file in place', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-outbox-'));
  const conversationId = 'outbox-drain-test';
  const conversationDir = buildConversationDirPath(conversationId, persistenceRoot);
  const queuePath = path.join(conversationDir, 'outbox.jsonl');

  try {
    await appendOutboundMessage(
      conversationId,
      persistenceRoot,
      { kind: 'current_thread_message', text: 'only item' },
      { turnId: 'turn-1' },
    );

    const claimed = await claimOutboundMessages(conversationId, persistenceRoot, {
      turnId: 'turn-1',
    });

    assert.deepEqual(claimed, [
      { kind: 'current_thread_message', text: 'only item' },
    ]);
    assert.equal(existsSync(queuePath), true);
    assert.equal(readFileSync(queuePath, 'utf8'), '');
  } finally {
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
