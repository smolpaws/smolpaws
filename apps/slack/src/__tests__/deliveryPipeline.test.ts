import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';

import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import type { LLMClient } from '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/llm/client.js';
import { MessageRelay, finalResponseExtractor } from '../../../../src/coordinator/messageRelay.js';
import {
  DeliveryDispatcher,
  DeliveryTargetRegistry,
  type DeliveryTarget,
} from '../../../../src/coordinator/deliveryDispatcher.js';
import { OutboundRelay } from '../../../../src/coordinator/outboundRelay.js';
import { MessageWorkStore } from '../../../../src/coordinator/store.js';
import type {
  AgentEvent,
  AgentServerClient,
  LaneDescriptor,
  LaneRow,
} from '../../../../src/coordinator/types.js';
import { SlackRelayRuntime, slackLaneDescriptor } from '../relayRuntime.js';
import { SlackDeliveryTarget } from '../deliveryTarget.js';

const NOW = Date.UTC(2026, 7, 16, 20, 0, 0);
const LANE: LaneDescriptor = {
  laneKey: 'channel:slack:T1:C1:100.001',
  platform: 'slack',
  accountId: 'T1',
  chatId: 'C1',
  threadId: '100.001',
};
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

function makeStore() {
  return new MessageWorkStore(new Database(':memory:'));
}

function readyLane(store: MessageWorkStore): LaneRow {
  store.resolveLane(LANE, CONVERSATION_ID, NOW);
  store.markLaneConversationReady(LANE.laneKey, NOW);
  const lane = store.getLane(LANE.laneKey);
  assert.ok(lane);
  return lane;
}

test('SlackDeliveryTarget routes durable lane coordinates and preserves thread_ts', async () => {
  const sent: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const target = new SlackDeliveryTarget(async (channel, text, threadTs) => {
    sent.push({ channel, text, threadTs });
    return '200.123';
  });
  const lane: LaneRow = {
    ...LANE,
    accountId: 'T1',
    threadId: '100.001',
    displayName: null,
    conversationId: CONVERSATION_ID,
    conversationReady: true,
    createdAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
  };

  target.validate(lane, { kind: 'current_thread_message', text: 'hello from relay' });
  const result = await target.deliver(lane, {
    kind: 'current_thread_message',
    text: 'hello from relay',
  });

  assert.deepEqual(sent, [
    { channel: 'C1', text: 'hello from relay', threadTs: '100.001' },
  ]);
  assert.equal(result.externalMessageId, '200.123');
});

test('DeliveryDispatcher settles a successful external send as done', async () => {
  const store = makeStore();
  const lane = readyLane(store);
  const work = store.insertDelivery(
    {
      sourceKey: 'event-1:lane',
      laneKey: lane.laneKey,
      conversationId: lane.conversationId,
      agentEventId: 'event-1',
      payload: { kind: 'current_thread_message', text: 'hello' },
    },
    NOW,
  );

  const targets = new DeliveryTargetRegistry();
  const target: DeliveryTarget = {
    validate: () => undefined,
    deliver: async () => ({ externalMessageId: 'slack-ts-1' }),
  };
  targets.register('slack', target);
  const dispatcher = new DeliveryDispatcher(store, targets, { now: () => NOW });

  const outcome = await dispatcher.dispatchNext('worker-1');
  assert.deepEqual(outcome, {
    kind: 'delivered',
    workId: work.id,
    externalMessageId: 'slack-ts-1',
  });
  assert.equal(store.getWork(work.id)?.state, 'done');
  assert.equal(store.getWork(work.id)?.externalMessageId, 'slack-ts-1');
});

test('DeliveryDispatcher turns an exception after markSending into delivery_unknown', async () => {
  const store = makeStore();
  const lane = readyLane(store);
  const work = store.insertDelivery(
    {
      sourceKey: 'event-2:lane',
      laneKey: lane.laneKey,
      conversationId: lane.conversationId,
      agentEventId: 'event-2',
      payload: { kind: 'current_thread_message', text: 'maybe' },
    },
    NOW,
  );

  const targets = new DeliveryTargetRegistry();
  targets.register('slack', {
    validate: () => undefined,
    deliver: async () => {
      throw new Error('socket closed after request write');
    },
  });
  const dispatcher = new DeliveryDispatcher(store, targets, { now: () => NOW });

  const outcome = await dispatcher.dispatchNext('worker-1');
  assert.equal(outcome.kind, 'delivery_unknown');
  assert.equal(store.getWork(work.id)?.state, 'delivery_unknown');
  assert.equal(store.getWork(work.id)?.sendAttempted, true);
});

class FakeAgentServer implements AgentServerClient {
  events: AgentEvent[] = [];

  async ensureConversation(): Promise<void> {}

  async appendEvent(
    _conversationId: string,
    event: { eventId: string },
  ): Promise<{ eventId: string; created: boolean }> {
    return { eventId: event.eventId, created: true };
  }

  async searchEvents(
    _conversationId: string,
    pageId: string | null,
    limit: number,
  ): Promise<{ items: AgentEvent[]; nextPageId: string | null }> {
    const start = pageId === null ? 0 : Number.parseInt(pageId, 10);
    const items = this.events.slice(start, start + limit);
    return {
      items,
      nextPageId: start + limit < this.events.length ? String(start + limit) : null,
    };
  }
}

test('OutboundRelay syncDeliveryOutbox + DeliveryDispatcher completes the new outbound path', async () => {
  const store = makeStore();
  const agent = new FakeAgentServer();
  const coordinator = new MessageRelay(store, agent, {
    now: () => NOW,
    deriveConversationId: () => CONVERSATION_ID,
    extractor: finalResponseExtractor,
  });
  const binding = await coordinator.resolveLane(LANE);
  agent.events = [
    {
      id: 'finish-1',
      kind: 'ObservationEvent',
      tool_name: 'finish',
      observation: { message: 'CAPYBARA' },
    },
  ];

  const sent: string[] = [];
  const targets = new DeliveryTargetRegistry();
  targets.register('slack', {
    validate: () => undefined,
    deliver: async (_lane, payload) => {
      sent.push((payload as { text: string }).text);
      return { externalMessageId: '300.123' };
    },
  });
  const dispatcher = new DeliveryDispatcher(store, targets, { now: () => NOW });
  const relay = new OutboundRelay(coordinator, dispatcher, {
    listConversationIds: () => [binding.conversationId],
  });

  assert.equal(await relay.syncDeliveryOutbox(binding.conversationId), 1);
  const tick = await relay.tick('relay-worker');
  assert.equal(tick.syncedDeliveries, 0);
  assert.equal(tick.dispatched, 1);
  assert.deepEqual(sent, ['CAPYBARA']);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery')[0]?.state, 'done');
});

test(
  'SlackRelayRuntime drives the real transpiled agent-server through finish to durable Slack delivery',
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slack-relay-real-server-'));
    const workspace = path.join(root, 'workspace');
    const dbPath = path.join(root, 'coordinator', 'slack.db');
    mkdirSync(workspace, { recursive: true });

    const sessionApiKey = 'slack-relay-real-server-test';
    const server = await createAgentServerApp({
      secretStore: memorySecretStore(),
      llmClientFactory: async (profile): Promise<LLMClient> => ({
        profile,
        complete: async () => ({
          message: {
            role: 'assistant',
            content: [],
            tool_calls: [
              {
                id: 'finish-slack-relay-e2e',
                responses_item_id: null,
                name: 'finish',
                arguments: JSON.stringify({ message: 'CAPYBARA-REAL-SERVER' }),
                origin: 'completion',
              },
            ],
            tool_call_id: null,
            name: null,
            reasoning_content: null,
            thinking_blocks: [],
            responses_reasoning_item: null,
          },
          usage: null,
        }),
      }),
      config: {
        conversationsPath: path.join(root, 'conversations'),
        bashEventsPath: path.join(root, 'bash-events'),
        statePath: path.join(root, 'server-state'),
        workspaceRoot: workspace,
        allowedFileRoots: [workspace],
        sessionApiKey,
      },
    });

    let runtime: SlackRelayRuntime | null = null;
    try {
      await server.app.listen({ host: '127.0.0.1', port: 0 });
      const serverUrl = localHost(server.app.server.address());
      const sent: Array<{ channel: string; text: string; threadTs?: string }> = [];

      runtime = new SlackRelayRuntime({
        logger: pino({ level: 'silent' }),
        serverUrl,
        sessionApiKey,
        dbPath,
        tickMs: 60_000,
        createConversationDefaults: {
          workspace: { kind: 'LocalWorkspace', working_dir: workspace },
          tags: { ingress: 'slack' },
        },
        sendChunk: async (channel, text, threadTs) => {
          sent.push({ channel, text, threadTs });
          return '400.123';
        },
      });
      await runtime.start();
      await runtime.accept({
        conversationId: 'slack-thread-T1-C1-100.001',
        prompt: 'Return the deterministic relay answer.',
        messageId: '100.002',
        platformContext: {
          team_id: 'T1',
          channel_id: 'C1',
          thread_ts: '100.001',
        },
      });

      for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) {
        await runtime.runOnce();
        if (sent.length === 0) await delay(10);
      }

      assert.deepEqual(sent, [
        {
          channel: 'C1',
          text: 'CAPYBARA-REAL-SERVER',
          threadTs: '100.001',
        },
      ]);

      await runtime.stop();
      runtime = null;

      const db = new Database(dbPath, { readonly: true });
      try {
        const lane = db
          .prepare(
            `SELECT lane_key, conversation_id, platform, chat_id, thread_id
             FROM lanes WHERE lane_key = ?`,
          )
          .get('channel:slack:T1:C1:100.001') as
          | {
              lane_key: string;
              conversation_id: string;
              platform: string;
              chat_id: string;
              thread_id: string | null;
            }
          | undefined;
        assert.ok(lane);
        assert.equal(lane.platform, 'slack');
        assert.equal(lane.chat_id, 'C1');
        assert.equal(lane.thread_id, '100.001');

        const intake = db
          .prepare(`SELECT state FROM work WHERE kind = 'intake' ORDER BY sequence DESC LIMIT 1`)
          .get() as { state: string } | undefined;
        const delivery = db
          .prepare(
            `SELECT state, send_attempted, external_message_id
             FROM work WHERE kind = 'delivery' ORDER BY sequence DESC LIMIT 1`,
          )
          .get() as
          | { state: string; send_attempted: number; external_message_id: string | null }
          | undefined;
        assert.deepEqual(intake, { state: 'done' });
        assert.deepEqual(delivery, {
          state: 'done',
          send_attempted: 1,
          external_message_id: '400.123',
        });

        const events = await fetch(
          `${serverUrl}/api/conversations/${lane.conversation_id}/events/search?sort_order=TIMESTAMP&limit=100`,
          { headers: { 'x-session-api-key': sessionApiKey } },
        );
        assert.equal(events.status, 200);
        const eventPage = (await events.json()) as {
          items?: Array<{
            kind?: string;
            tool_name?: string;
            observation?: { text?: string };
          }>;
        };
        const finish = (eventPage.items ?? []).find(
          (event) => event.kind === 'ObservationEvent' && event.tool_name === 'finish',
        );
        assert.equal(finish?.observation?.text, 'CAPYBARA-REAL-SERVER');
      } finally {
        db.close();
      }
    } finally {
      await runtime?.stop().catch(() => undefined);
      await server.app.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('slackLaneDescriptor derives durable DM and thread lanes from normalized ingress', () => {
  const base = {
    prompt: 'hello',
    messageId: 'C1:100.002',
    platformContext: { team_id: 'T1', channel_id: 'C1', thread_ts: '100.001' },
  };
  assert.deepEqual(
    slackLaneDescriptor({ ...base, conversationId: 'slack-thread-T1-C1-100.001' }),
    {
      laneKey: 'channel:slack:T1:C1:100.001',
      platform: 'slack',
      accountId: 'T1',
      chatId: 'C1',
      threadId: '100.001',
      displayName: 'slack-thread-T1-C1-100.001',
    },
  );
  assert.equal(
    slackLaneDescriptor({ ...base, conversationId: 'slack-im-T1-C1' }).threadId,
    null,
  );
});

function memorySecretStore() {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    has: async () => false,
  };
}

function localHost(address: string | AddressInfo | null): string {
  if (address === null || typeof address === 'string') {
    throw new Error('Expected agent-server TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
