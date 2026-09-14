import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MessageWorkStore } from './store.js';
import { queueMedia, type OutboundMedia } from './outboundMedia.js';
import type { ScheduledLane } from './taskScheduler.js';

test('media keeps accepted bytes across retries and enforces the existing scope boundary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'media-outbox-')); const workspace = path.join(root, 'group'); mkdirSync(workspace);
  const dbPath = path.join(root, 'relay.db'); const db = new Database(dbPath); const store = new MessageWorkStore(db);
  const lane: ScheduledLane = { conversationId: 'conversation', scopeId: 'group', workingDir: workspace, relayDbPath: dbPath, defaults: {}, lane: { laneKey: 'lane', platform: 'whatsapp', chatId: 'chat', accountId: null, threadId: null } };
  store.resolveLane(lane.lane, lane.conversationId, Date.now());
  try {
    writeFileSync(path.join(workspace, 'voice.ogg'), 'original');
    const args = { path: 'voice.ogg', media_type: 'audio', voice_note: true };
    const id = queueMedia(lane, args, 'action'); writeFileSync(path.join(workspace, 'voice.ogg'), 'changed');
    assert.equal(queueMedia(lane, args, 'action'), id);
    assert.equal(readFileSync((store.getWork(id)!.payload as OutboundMedia).path, 'utf8'), 'original');
    writeFileSync(path.join(root, 'other.ogg'), 'other'); symlinkSync(path.join(root, 'other.ogg'), path.join(workspace, 'escape.ogg'));
    assert.throws(() => queueMedia(lane, { ...args, path: '../other.ogg' }, 'other'), /scope/);
    assert.throws(() => queueMedia(lane, { ...args, path: 'escape.ogg' }, 'symlink'), /scope/);
    assert.ok(queueMedia({ ...lane, scopeId: 'main' }, { ...args, path: '../other.ogg' }, 'control'));
    assert.throws(() => queueMedia(lane, { ...args, mime_type: 'audio/mpeg' }, 'invalid'), /OGG/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
