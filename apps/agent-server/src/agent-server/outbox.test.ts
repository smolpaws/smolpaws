import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
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
