/**
 * Integration proof: the coordinator driving the REAL upstream-shaped agent-server, not a fake.
 *
 * This is the bridge from "unit-green" to "works against the real server". It starts the actual
 * TypeScript Fastify app on an ephemeral port, points the real {@link HttpAgentServerClient} at it, and
 * runs `resolveLane → acceptInbound → integrateNextIntake` end-to-end. It asserts the
 * append-response-loss guarantee at the real seam: the intake lands with `created:true`, and an
 * idempotent replay of the same deterministic `event_id` returns `created:false` with no duplicate user
 * turn.
 *
 * Isolated and additive: temp SQLite + server state + conversations, no production delivery path or
 * machine profiles/keychain. Full run-to-delivery behavior is covered by the Slack real-server relay test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentServerApp } from '@smolpaws/openhands-agent-server';
import Database from 'better-sqlite3';

import { MessageRelay } from './messageRelay.js';
import { HttpAgentServerClient } from './httpAgentServerClient.js';
import { deterministicConversationId, deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
import type { LaneDescriptor, RetryPolicy } from './types.js';

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 1_000,
  capBackoffMs: 8_000,
  claimTtlMs: 60_000,
};
const SESSION_KEY = 'integration-slice';

/** Minimal structural view of the returned app — avoids depending on Fastify types from the host. */
interface AppLike {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | { readonly port: number } | null };
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function listen(app: AppLike): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function userMessageIds(baseUrl: string, conversationId: string): Promise<string[]> {
  const response = await fetch(
    `${baseUrl}/api/conversations/${conversationId}/events/search?kind=MessageEvent&source=user&sort_order=TIMESTAMP`,
    { headers: { 'x-session-api-key': SESSION_KEY } },
  );
  assert.equal(response.status, 200, 'events/search should return 200');
  const body = (await response.json()) as {
    items?: Array<{ id: string; kind: string; source: string }>;
  };
  return (body.items ?? []).map((event) => event.id);
}

test(
  'coordinator drives the REAL agent-server: intake lands created:true, event_id replay is created:false',
  async () => {
    const conversationsPath = tempDir('mwc-int-conv-');
    const runtimeRoot = tempDir('mwc-int-runtime-');
    const server = await createAgentServerApp({
      // This test verifies the coordinator↔HTTP contract, not profile selection or LLM execution.
      // Supplying an explicit factory disables the product profile preparer. A requested run may fail in
      // the background, which is acceptable here; append and replay semantics are the subject under test.
      agentFactory: async () => {
        throw new Error('integration_test_agent_not_configured');
      },
      secretStore: memorySecretStore(),
      config: {
        conversationsPath,
        bashEventsPath: path.join(runtimeRoot, 'bash-events'),
        statePath: path.join(runtimeRoot, 'server-state'),
        workspaceRoot: runtimeRoot,
        allowedFileRoots: [runtimeRoot],
        sessionApiKey: SESSION_KEY,
      },
    });
    const app = server.app as unknown as AppLike;
    const baseUrl = await listen(app);
    try {
      const client = new HttpAgentServerClient({
        baseUrl,
        sessionApiKey: SESSION_KEY,
        createDefaults: {
          workspace: { kind: 'LocalWorkspace', working_dir: runtimeRoot },
          tags: { ingress: 'coordinator-integration-test' },
        },
      });
      const store = new MessageWorkStore(
        new Database(path.join(runtimeRoot, 'coordinator.db')),
        POLICY,
      );
      const coordinator = new MessageRelay(store, client);

      const descriptor: LaneDescriptor = {
        laneKey: 'channel:slack:T1:C1:root',
        platform: 'slack',
        accountId: 'T1',
        chatId: 'C1',
        threadId: null,
      };
      const sourceMessageId = 'm-int-1';
      const expectedConversationId = deterministicConversationId(descriptor.laneKey);
      const expectedEventId = deterministicEventId(descriptor.platform, sourceMessageId);

      const binding = await coordinator.resolveLane(descriptor);
      assert.equal(binding.conversationId, expectedConversationId);
      assert.equal(binding.conversationReady, true);
      const created = await fetch(`${baseUrl}/api/conversations/${expectedConversationId}`, {
        headers: { 'x-session-api-key': SESSION_KEY },
      });
      assert.equal(created.status, 200, 'the conversation should now exist on the server');

      await coordinator.acceptInbound(descriptor, {
        sourceMessageId,
        content: 'hello from the integration slice',
      });
      const outcome = await coordinator.integrateNextIntake('w-int');
      assert.equal(outcome.kind, 'integrated');
      assert.equal(
        (outcome as { eventCreated: boolean }).eventCreated,
        true,
        'first append is created:true',
      );

      const afterFirst = await userMessageIds(baseUrl, expectedConversationId);
      assert.deepEqual(
        afterFirst,
        [expectedEventId],
        'one user event, under the coordinator-supplied id',
      );

      const replay = await client.appendEvent(expectedConversationId, {
        eventId: expectedEventId,
        role: 'user',
        content: 'hello from the integration slice',
        run: true,
      });
      assert.equal(replay.created, false, 'replay of the same event_id is created:false');
      assert.equal(replay.eventId, expectedEventId);
      const afterReplay = await userMessageIds(baseUrl, expectedConversationId);
      assert.deepEqual(
        afterReplay,
        [expectedEventId],
        'still exactly one user event — no duplicate turn',
      );

      const conversationResponse = await fetch(
        `${baseUrl}/api/conversations/${expectedConversationId}`,
        { headers: { 'x-session-api-key': SESSION_KEY } },
      );
      const conversation = (await conversationResponse.json()) as {
        execution_status?: unknown;
      };
      assert.equal(
        typeof conversation.execution_status,
        'string',
        'run request left a defined execution status',
      );
    } finally {
      await app.close();
      rmSync(conversationsPath, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  },
);

function memorySecretStore() {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    has: async () => false,
  };
}
