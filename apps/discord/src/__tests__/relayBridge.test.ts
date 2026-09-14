import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';

import { MessageWorkStore } from '../../../../src/coordinator/store.js';
import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import { DiscordBridge, type DiscordClientLike, type DiscordMessageLike } from '../adapter.js';
import { loadConfig } from '../config.js';
import { extractPrompt, laneDescriptorFor, shouldRespond, splitDiscordMessage, triggerPatternFor } from '../handler.js';

type OpenHandsAgentModule = typeof import(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js'
);
const require = createRequire(import.meta.url);
const { Agent, FinishTool, TestLLM } = require(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs',
) as OpenHandsAgentModule;

const SESSION_KEY = 'discord-real-server-relay';
const EXPECTED_REPLY = 'CAPYBARA-DISCORD-RELAY';
const BOT_ID = '999000';
const DM_TYPE = 1;
const GUILD_TEXT_TYPE = 0;

interface AppLike {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | { readonly port: number } | null };
}

function agentFactory() {
  return new Agent({
    llm: TestLLM.fromMessages([{
      role: 'assistant',
      content: [],
      tool_calls: [{ id: 'finish-discord', responses_item_id: null, name: 'finish', arguments: JSON.stringify({ message: EXPECTED_REPLY }), origin: 'completion' }],
      tool_call_id: null,
      name: null,
      reasoning_content: null,
      thinking_blocks: [],
      responses_reasoning_item: null,
    }]),
    tools: [FinishTool.create()],
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
  throw new Error('timed out waiting for the real Discord relay path');
}

class FakeClient implements DiscordClientLike {
  readonly sent: Array<{ channelId: string; content: string }> = [];
  readonly handlers = new Map<string, Array<(payload: never) => void>>();
  /** When false, `login` resolves without ever emitting `clientReady` until `emitReady()` is called. */
  autoReady = true;
  channels = {
    fetch: async (channelId: string) => ({
      send: async ({ content = '' }: { content?: string }) => {
        this.sent.push({ channelId, content });
        return { id: `D-${this.sent.length}` };
      },
    }),
  };

  async login(): Promise<void> {
    if (this.autoReady) queueMicrotask(() => this.emitReady());
  }

  emitReady(): void {
    for (const handler of this.handlers.get('clientReady') ?? []) handler({ user: { id: BOT_ID, tag: 'paws#0001' } } as never);
  }

  destroy(): void {}

  once(event: string, handler: (payload: never) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  on(event: string, handler: (payload: never) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
}

function message(overrides: Partial<DiscordMessageLike> & { replies?: string[] }): DiscordMessageLike {
  const replies = overrides.replies ?? [];
  return {
    id: 'M1',
    content: '@smolpaws hello',
    channelId: 'C1',
    guildId: 'G1',
    author: { id: 'U1', tag: 'engel#0001', bot: false },
    channel: { type: GUILD_TEXT_TYPE, isThread: () => false },
    mentions: { has: () => false },
    reply: async ({ content }) => {
      replies.push(content);
    },
    ...overrides,
  };
}

test('handler policy: DMs, mentions, and the text trigger address the cat; bots never do', () => {
  const trigger = triggerPatternFor('@smolpaws');
  const base = { messageId: 'M', channelId: 'C', guildId: 'G', isDirectMessage: false, isThread: false, authorId: 'U', authorTag: 'u', authorIsBot: false, content: 'hi', mentionsBot: false };
  assert.equal(shouldRespond(base, trigger), false);
  assert.equal(shouldRespond({ ...base, isDirectMessage: true, guildId: null }, trigger), true);
  assert.equal(shouldRespond({ ...base, mentionsBot: true }, trigger), true);
  assert.equal(shouldRespond({ ...base, content: 'hey @SmolPaws' }, trigger), true);
  assert.equal(shouldRespond({ ...base, content: 'hey @smolpaws', authorIsBot: true }, trigger), false);
  assert.equal(extractPrompt(`<@!${BOT_ID}> @smolpaws  fix the build`, BOT_ID, trigger), 'fix the build');
  assert.deepEqual(laneDescriptorFor({ ...base, isDirectMessage: true, guildId: null }, BOT_ID), {
    laneKey: `discord:${BOT_ID}:dm:U`,
    platform: 'discord',
    accountId: BOT_ID,
    chatId: 'C',
    threadId: null,
    displayName: 'discord-dm-U',
  });
  assert.equal(laneDescriptorFor({ ...base, isThread: true }, BOT_ID).laneKey, `discord:${BOT_ID}:thread:C`);
  assert.equal(laneDescriptorFor(base, BOT_ID).laneKey, `discord:${BOT_ID}:channel:C`);
  const chunks = splitDiscordMessage('word '.repeat(1000));
  assert.ok(chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 2000));
});

test('config fails closed without an allowlist and rejects the removed variable alongside its replacement', () => {
  const warnings: string[] = [];
  const config = loadConfig({ DISCORD_BOT_TOKEN: 't' }, (m) => warnings.push(m));
  assert.equal(config.allowedUserIds.size, 0);
  assert.ok(warnings.some((w) => w.includes('fail closed')));
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_ALLOWED_USERS: 'a', DISCORD_ALLOWED_USER_IDS: '1' }));
  assert.throws(() => loadConfig({}));
});

test('Discord ingress reaches the real TypeScript agent-server and returns through the durable relay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'discord-relay-'));
  const dbPath = path.join(root, 'discord.db');
  const server = await createAgentServerApp({ agentFactory, config: { conversationsPath: path.join(root, 'conversations'), sessionApiKey: SESSION_KEY } });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);
  const client = new FakeClient();
  const bridge = new DiscordBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    config: loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_ALLOWED_USER_IDS: 'U1' }),
    dbPath,
    tickMs: 60_000,
    createConversationDefaults: { tags: { ingress: 'discord' } },
    clientFactory: () => client,
  });

  try {
    await bridge.start();

    // Unauthorized user: refused politely, never accepted.
    const strangerReplies: string[] = [];
    await bridge.onMessage(message({ id: 'S1', author: { id: 'U2', tag: 'x#1', bot: false }, replies: strangerReplies }));
    assert.equal(strangerReplies.length, 1);
    assert.ok(strangerReplies[0]?.includes('trusted circle'));

    // Not addressed: ignored.
    await bridge.onMessage(message({ id: 'N1', content: 'just chatting' }));
    // Mention with no prompt: hint.
    const hintReplies: string[] = [];
    await bridge.onMessage(message({ id: 'H1', content: `<@${BOT_ID}>`, mentions: { has: () => true }, replies: hintReplies }));
    assert.equal(hintReplies.length, 1);

    // Addressed and authorized: one intake, one delivery to the channel.
    await bridge.onMessage(message({ id: 'M1', content: '@smolpaws say the words' }));
    await waitFor(() => client.sent.length > 0, () => bridge['runtime']!.runOnce());
    assert.deepEqual(client.sent, [{ channelId: 'C1', content: EXPECTED_REPLY }]);

    // Replay is idempotent at the durable boundary.
    await bridge.onMessage(message({ id: 'M1', content: '@smolpaws say the words' }));
    await bridge['runtime']!.runOnce();
    assert.equal(client.sent.length, 1);
  } finally {
    await bridge.stop();
    await app.close();
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`SELECT kind, source_key, state, send_attempted, external_message_id FROM work ORDER BY kind ASC, sequence ASC`).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => [row.kind, row.state, row.send_attempted, row.external_message_id]), [
      ['delivery', 'done', 1, 'D-1'],
      ['intake', 'done', 0, null],
    ]);
    assert.equal(rows[1]?.source_key, `discord:${BOT_ID}:M1`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Restart regression: a delivery left `ready` by a previous run must not be attempted before the gateway
 * client is ready, and must go out once it is. The relay worker only starts after `clientReady`.
 */
test('queued deliveries wait as ready until the Discord client is ready, then go out once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'discord-relay-restart-'));
  const dbPath = path.join(root, 'discord.db');
  const server = await createAgentServerApp({ agentFactory, config: { conversationsPath: path.join(root, 'conversations'), sessionApiKey: SESSION_KEY } });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);
  const laneKey = `discord:${BOT_ID}:channel:C1`;
  const makeBridge = (client: FakeClient) => new DiscordBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    config: loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_ALLOWED_USER_IDS: 'U1' }),
    dbPath,
    tickMs: 60_000,
    clientFactory: () => client,
  });
  const seeded = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare(`SELECT state, send_attempted FROM work WHERE kind = 'delivery' AND source_key = ?`).get(`seeded:${laneKey}`) as { state: string; send_attempted: number };
    } finally {
      db.close();
    }
  };

  try {
    // Run 1 establishes the lane and its conversation, then the process "dies" with a reply still queued.
    const first = new FakeClient();
    const bridge1 = makeBridge(first);
    await bridge1.start();
    await bridge1.onMessage(message({ id: 'M1', content: '@smolpaws say the words' }));
    await waitFor(() => first.sent.length > 0, () => bridge1['runtime']!.runOnce());
    await bridge1.stop();
    const seedDb = new Database(dbPath);
    try {
      new MessageWorkStore(seedDb).insertDelivery(
        { sourceKey: `seeded:${laneKey}`, laneKey, agentEventId: 'seeded', payload: { kind: 'current_thread_message', text: 'left over' } },
        Date.now(),
      );
    } finally {
      seedDb.close();
    }
    assert.deepEqual(seeded(), { state: 'ready', send_attempted: 0 });

    // Run 2: login succeeds but the gateway is not ready; nothing is attempted and the row stays ready.
    const second = new FakeClient();
    second.autoReady = false;
    const bridge2 = makeBridge(second);
    const starting = bridge2.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge2.connected, false);
    assert.deepEqual(seeded(), { state: 'ready', send_attempted: 0 });

    second.emitReady();
    await starting;
    await waitFor(() => second.sent.length > 0, () => bridge2['runtime']!.runOnce());
    assert.deepEqual(second.sent, [{ channelId: 'C1', content: 'left over' }]);
    assert.deepEqual(seeded(), { state: 'done', send_attempted: 1 });
    await bridge2.stop();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
