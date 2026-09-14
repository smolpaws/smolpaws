import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MessageWorkStore } from '../../../src/coordinator/store.js';
import { WhatsAppDeliveryTarget } from '../../whatsapp/src/deliveryTarget.js';
import { SlackDeliveryTarget } from '../../slack/src/deliveryTarget.js';
import { DiscordDeliveryTarget } from '../../discord/src/deliveryTarget.js';
import type { MediaSender, OutboundMedia } from '../../../src/coordinator/outboundMedia.js';
import { importVoiceOutbox } from '../../whatsapp/src/voiceOutbox.js';

test('all three delivery targets pass media to the native sender; legacy voice batches retry idempotently', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'media-targets-')); const file = path.join(root, 'voice.ogg'); writeFileSync(file, 'voice');
  const media: OutboundMedia = { kind: 'current_thread_media', path: file, mediaType: 'audio', mimeType: 'audio/ogg; codecs=opus', fileName: 'voice.ogg', voiceNote: true };
  const sent: unknown[] = []; const send: MediaSender = async (...args) => { sent.push(args); return 'id'; };
  const db = new Database(path.join(root, 'relay.db')); const store = new MessageWorkStore(db);
  try {
    for (const [platform, target] of [['whatsapp', new WhatsAppDeliveryTarget(async () => null, 'cat', () => true, send)], ['slack', new SlackDeliveryTarget(async () => null, send)], ['discord', new DiscordDeliveryTarget(async () => null, () => true, send)]] as const) {
      const lane = store.resolveLane({ laneKey: platform, platform, chatId: 'chat', accountId: null, threadId: 'thread' }, platform, Date.now());
      const row = store.getLane(lane.laneKey)!; target.validate(row, media); assert.equal((await target.deliver(row, media)).externalMessageId, 'id');
    }
    assert.equal(sent.length, 3);
    const outbox = path.join(root, 'voice-outbox.jsonl'); const body = JSON.stringify({ jid: 'chat', oggPath: file }) + '\n'; writeFileSync(outbox, body + JSON.stringify({ jid: 'later', oggPath: file }) + '\n');
    const registration = { conversationId: 'whatsapp', scopeId: 'main', workingDir: root, relayDbPath: path.join(root, 'relay.db'), defaults: {}, lane: { laneKey: 'whatsapp', platform: 'whatsapp', chatId: 'chat', accountId: null, threadId: null } };
    assert.throws(() => importVoiceOutbox(outbox, jid => jid === 'chat' ? registration : undefined), /registered/);
    assert.equal(importVoiceOutbox(outbox, () => registration), 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work WHERE kind='delivery'").get() as { n: number }).n, 2);
    writeFileSync(outbox, body); assert.equal(importVoiceOutbox(outbox, () => registration), 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work WHERE kind='delivery'").get() as { n: number }).n, 3);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
