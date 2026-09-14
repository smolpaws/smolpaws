import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';

import { MessageWorkStore } from '../../../../src/coordinator/store.js';
import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import { WhatsAppBridge, type ConnectionUpdate, type WhatsAppSocketLike } from '../adapter.js';
import { loadConfig } from '../config.js';
import { verifyRelayDrained } from '../handoff.js';
import { whatsappExtractor } from '../relayRuntime.js';

type OpenHandsAgentModule = typeof import(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js'
);
const require = createRequire(import.meta.url);
const { Agent, FinishTool, SendMessageTool, TestLLM } = require(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs',
) as OpenHandsAgentModule;

const SESSION_KEY = 'whatsapp-real-server-relay';
const MID_TURN = 'CAPYBARA-MID-TURN';
const FINAL = 'CAPYBARA-FINAL';

interface AppLike {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | { readonly port: number } | null };
}

function assistant(toolCalls: Array<{ id: string; name: string; arguments: string }>) {
  return {
    role: 'assistant' as const,
    content: [],
    tool_calls: toolCalls.map((call) => ({ ...call, responses_item_id: null, origin: 'completion' as const })),
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

/** First turn: send a mid-turn message, then finish. Proves both extractor branches deliver once each. */
function agentFactory() {
  return new Agent({
    llm: TestLLM.fromMessages([
      assistant([{ id: 'send-1', name: 'send_message', arguments: JSON.stringify({ text: MID_TURN }) }]),
      assistant([{ id: 'finish-1', name: 'finish', arguments: JSON.stringify({ message: FINAL }) }]),
    ]),
    tools: [SendMessageTool.create(), FinishTool.create()],
  });
}

async function listen(app: AppLike): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean, drive: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await drive();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the real WhatsApp relay path');
}

class FakeSocket implements WhatsAppSocketLike {
  readonly handlers: Record<string, Array<(payload: never) => unknown>> = {};
  readonly sent: Array<{ jid: string; text: string }> = [];
  readonly presence: string[] = [];
  user = { id: '4915551234:12@s.whatsapp.net', lid: null };
  ev = {
    on: (event: string, handler: (payload: never) => unknown): void => {
      (this.handlers[event] ??= []).push(handler);
    },
  } as WhatsAppSocketLike['ev'];

  emit(event: string, payload: unknown): Promise<unknown[]> {
    return Promise.all((this.handlers[event] ?? []).map((handler) => handler(payload as never)));
  }

  async sendMessage(jid: string, content: Parameters<WhatsAppSocketLike['sendMessage']>[1], options?: { messageId: string }) {
    if (content.audio) return { key: { id: options?.messageId ?? 'MEDIA' } };
    this.sent.push({ jid, text: content.text ?? '' });
    return { key: { id: `WA-${this.sent.length}` } };
  }

  async sendPresenceUpdate(presence: 'composing' | 'paused'): Promise<void> {
    this.presence.push(presence);
  }

  async groupFetchAllParticipating() {
    return { '123@g.us': { subject: 'Team' } };
  }
}

test('whatsappExtractor delivers send_message actions and terminal responses', () => {
  const action = { id: 'e1', kind: 'ActionEvent', tool_name: 'send_message', action: { text: 'hi' } };
  const finish = { id: 'e2', kind: 'ObservationEvent', tool_name: 'finish', observation: { message: 'bye' } };
  const other = { id: 'e3', kind: 'ActionEvent', tool_name: 'terminal', action: { command: 'ls' } };
  assert.deepEqual(whatsappExtractor(action)?.payload, { kind: 'current_thread_message', text: 'hi' });
  assert.deepEqual(whatsappExtractor(finish)?.payload, { kind: 'current_thread_message', text: 'bye' });
  assert.equal(whatsappExtractor(other), null);
});

test('WhatsApp ingress reaches the real TypeScript agent-server and returns through the durable relay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsapp-relay-'));
  const conversationsPath = path.join(root, 'conversations');
  const repoRoot = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'groups', 'team'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'data', 'registered_groups.json'),
    JSON.stringify({ '123@g.us': { name: 'Team', folder: 'team', trigger: '@smolpaws', added_at: '2026-01-01' } }),
  );
  const config = { ...loadConfig({ HOME: home }, repoRoot), pollIntervalMs: 60_000, debounceMs: 0 };
  const relayDbPath = path.join(root, 'whatsapp-relay.db');

  const server = await createAgentServerApp({ agentFactory, config: { conversationsPath, sessionApiKey: SESSION_KEY } });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);

  const socket = new FakeSocket();
  const bridge = new WhatsAppBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    config,
    relayDbPath,
    ledgerPath: path.join(root, 'messages.db'),
    tickMs: 60_000,
    startupPing: false,
    createConversationDefaults: { tags: { ingress: 'whatsapp' } },
    socketFactory: async () => ({ socket, saveCreds: () => undefined }),
    downloadMedia: async () => Buffer.from('fake media'),
  });

  try {
    await bridge.start();
    // The relay worker does not exist until WhatsApp reports the socket open.
    assert.equal(bridge.connected, false);
    await socket.emit('connection.update', { connection: 'open' } satisfies ConnectionUpdate);
    await bridge.whenReady();

    const upsert = (id: string, text: string, seconds: number, chat = '123@g.us') => ({
      messages: [{
        key: { remoteJid: chat, id, fromMe: false, participant: '111@s.whatsapp.net' },
        message: { conversation: text },
        messageTimestamp: seconds,
        pushName: 'Engel',
      }],
    });
    // Unregistered chat: metadata only, never dispatched.
    await socket.emit('messages.upsert', upsert('X1', '@smolpaws are you there', 1_700_000_000, '999@g.us'));
    // Registered but not addressed: recorded for context, not dispatched.
    await socket.emit('messages.upsert', upsert('M1', 'morning all', 1_700_000_001));
    await bridge.pollOnce();
    assert.equal(bridge['runtime']?.workStore.getWorkBySourceKey('intake', 'whatsapp:4915551234:M1'), null);

    // Addressed: the batch (M1 + M2) becomes one intake keyed by the newest message.
    await socket.emit('messages.upsert', upsert('M2', '@smolpaws say the words', 1_700_000_002));
    await bridge.pollOnce();

    await waitFor(
      () => socket.sent.length >= 2,
      () => bridge['runtime']!.runOnce(),
    );
    assert.deepEqual(socket.sent, [
      { jid: '4915551234@s.whatsapp.net', text: `smolpaws: ${MID_TURN}` },
      { jid: '4915551234@s.whatsapp.net', text: `smolpaws: ${FINAL}` },
    ].map((entry) => ({ ...entry, jid: '123@g.us' })));
    assert.deepEqual(socket.presence, ['composing', 'paused']);

    // A voice note has no text prefix. Its preallocated ID must suppress its own account echo.
    const voiceId = await bridge['sendMedia']('123@g.us', { kind: 'current_thread_media', path: '/tmp/fake.ogg', mediaType: 'audio', mimeType: 'audio/ogg; codecs=opus', fileName: 'fake.ogg', voiceNote: true });
    await socket.emit('messages.upsert', { messages: [{ key: { remoteJid: '123@g.us', id: voiceId, fromMe: true },
      message: { audioMessage: { mimetype: 'audio/ogg' } }, messageTimestamp: 1_700_000_003 }] });
    await bridge.pollOnce();
    assert.equal(bridge['runtime']?.workStore.getWorkBySourceKey('intake', `whatsapp:4915551234:${voiceId}`), null);

    // Replaying the same upsert is idempotent at the durable boundary.
    await socket.emit('messages.upsert', upsert('M2', '@smolpaws say the words', 1_700_000_002));
    await bridge.pollOnce();
    await bridge['runtime']!.runOnce();
    assert.equal(socket.sent.length, 2);
    const handoffDb = new Database(relayDbPath);
    try {
      await verifyRelayDrained(handoffDb, baseUrl, SESSION_KEY);
      handoffDb.prepare("UPDATE work SET state='failed' WHERE kind='intake'").run();
      await assert.rejects(verifyRelayDrained(handoffDb, baseUrl, SESSION_KEY), /unsettled/);
      handoffDb.prepare("UPDATE work SET state='done' WHERE kind='intake'").run();
    } finally { handoffDb.close(); }
  } finally {
    await bridge.stop();
    await app.close();
  }

  const db = new Database(relayDbPath, { readonly: true });
  try {
    const lanes = db.prepare(`SELECT lane_key, platform, chat_id FROM lanes`).all() as Array<{ lane_key: string; platform: string; chat_id: string }>;
    assert.deepEqual(lanes, [{ lane_key: 'whatsapp:4915551234:123@g.us', platform: 'whatsapp', chat_id: '123@g.us' }]);
    const rows = db
      .prepare(`SELECT kind, source_key, state, send_attempted, external_message_id FROM work ORDER BY kind ASC, sequence ASC`)
      .all() as Array<{ kind: string; source_key: string; state: string; send_attempted: number; external_message_id: string | null }>;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.filter((row) => row.kind === 'delivery').map((row) => [row.state, row.send_attempted, row.external_message_id]), [
      ['done', 1, 'WA-1'],
      ['done', 1, 'WA-2'],
    ]);
    assert.deepEqual(rows.filter((row) => row.kind === 'intake').map((row) => [row.source_key, row.state]), [
      ['whatsapp:4915551234:M2', 'done'],
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const LANE_KEY = 'whatsapp:4915551234:123@g.us';

/**
 * Restart regression: a delivery that was `ready` when the previous process died must stay deliverable
 * while the new process has no usable transport yet, and must go out once the socket opens. Sending
 * against a socket that is not open must never turn the row into `delivery_unknown`.
 */
test('queued deliveries wait as ready until the WhatsApp socket is open, then go out once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsapp-relay-restart-'));
  const repoRoot = path.join(root, 'repo');
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'groups', 'team'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'data', 'registered_groups.json'),
    JSON.stringify({ '123@g.us': { name: 'Team', folder: 'team', trigger: '@smolpaws', added_at: '2026-01-01' } }),
  );
  const config = { ...loadConfig({ HOME: path.join(root, 'home') }, repoRoot), pollIntervalMs: 60_000, debounceMs: 0 };
  const relayDbPath = path.join(root, 'whatsapp-relay.db');
  const server = await createAgentServerApp({
    agentFactory,
    config: { conversationsPath: path.join(root, 'conversations'), sessionApiKey: SESSION_KEY },
  });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);

  const makeBridge = (socket: FakeSocket) => new WhatsAppBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    config,
    relayDbPath,
    ledgerPath: path.join(root, 'messages.db'),
    tickMs: 60_000,
    startupPing: false,
    socketFactory: async () => ({ socket, saveCreds: () => undefined }),
    downloadMedia: async () => Buffer.from('fake media'),
  });
  const upsert = (id: string, text: string, seconds: number) => ({
    messages: [{
      key: { remoteJid: '123@g.us', id, fromMe: false, participant: '111@s.whatsapp.net' },
      message: { conversation: text },
      messageTimestamp: seconds,
      pushName: 'Engel',
    }],
  });
  const deliveryStates = () => {
    const db = new Database(relayDbPath, { readonly: true });
    try {
      return db
        .prepare(`SELECT source_key, state, send_attempted FROM work WHERE kind = 'delivery' ORDER BY sequence ASC`)
        .all() as Array<{ source_key: string; state: string; send_attempted: number }>;
    } finally {
      db.close();
    }
  };

  try {
    // Run 1: establish the lane and its conversation through the normal path, then "crash" the process.
    const first = new FakeSocket();
    const bridge1 = makeBridge(first);
    await bridge1.start();
    await first.emit('connection.update', { connection: 'open' } satisfies ConnectionUpdate);
    await bridge1.whenReady();
    await first.emit('messages.upsert', upsert('M1', '@smolpaws say the words', 1_700_000_001));
    await bridge1.pollOnce();
    await waitFor(() => first.sent.length >= 2, () => bridge1['runtime']!.runOnce());
    await bridge1.stop();

    // A reply that was projected but never sent before the crash.
    const seedDb = new Database(relayDbPath);
    try {
      new MessageWorkStore(seedDb).insertDelivery(
        { sourceKey: `seeded-event:${LANE_KEY}`, laneKey: LANE_KEY, agentEventId: 'seeded-event', payload: { kind: 'current_thread_message', text: 'left over from the previous run' } },
        Date.now(),
      );
    } finally {
      seedDb.close();
    }
    assert.deepEqual(deliveryStates().filter((row) => row.source_key.startsWith('seeded')), [
      { source_key: `seeded-event:${LANE_KEY}`, state: 'ready', send_attempted: 0 },
    ]);

    // Run 2: the transport is not open yet, so no relay worker runs and the row is untouched.
    const second = new FakeSocket();
    const bridge2 = makeBridge(second);
    await bridge2.start();
    assert.equal(bridge2.connected, false);
    assert.deepEqual(deliveryStates().filter((row) => row.source_key.startsWith('seeded')), [
      { source_key: `seeded-event:${LANE_KEY}`, state: 'ready', send_attempted: 0 },
    ]);

    // Socket opens: the worker starts and the leftover reply goes out exactly once.
    await second.emit('connection.update', { connection: 'open' } satisfies ConnectionUpdate);
    await bridge2.whenReady();
    await waitFor(() => second.sent.length >= 1, () => bridge2['runtime']!.runOnce());
    assert.deepEqual(second.sent, [{ jid: '123@g.us', text: 'smolpaws: left over from the previous run' }]);
    assert.deepEqual(deliveryStates().filter((row) => row.source_key.startsWith('seeded')), [
      { source_key: `seeded-event:${LANE_KEY}`, state: 'done', send_attempted: 1 },
    ]);

    // Mid-run disconnect: a new reply stays `ready` (never claimed) until the socket is back.
    await second.emit('connection.update', { connection: 'close', lastDisconnect: { error: undefined } } satisfies ConnectionUpdate);
    const dropDb = new Database(relayDbPath);
    try {
      new MessageWorkStore(dropDb).insertDelivery(
        { sourceKey: `seeded-event-2:${LANE_KEY}`, laneKey: LANE_KEY, agentEventId: 'seeded-event-2', payload: { kind: 'current_thread_message', text: 'sent while offline' } },
        Date.now(),
      );
    } finally {
      dropDb.close();
    }
    await bridge2['runtime']!.runOnce();
    await bridge2['runtime']!.runOnce();
    assert.equal(second.sent.length, 1);
    assert.deepEqual(deliveryStates().filter((row) => row.source_key.startsWith('seeded-event-2')), [
      { source_key: `seeded-event-2:${LANE_KEY}`, state: 'ready', send_attempted: 0 },
    ]);
    await second.emit('connection.update', { connection: 'open' } satisfies ConnectionUpdate);
    await waitFor(() => second.sent.length >= 2, () => bridge2['runtime']!.runOnce());
    assert.equal(second.sent[1]?.text, 'smolpaws: sent while offline');
    await bridge2.stop();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
