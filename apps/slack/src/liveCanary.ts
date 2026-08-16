/**
 * Temporary live Slack canary for the complete durable path.
 *
 * It starts the real TypeScript agent-server with a deterministic test LLM, then connects a second
 * Socket Mode client through SlackBridge. The ordinary Slack path is untouched. Every accepted canary
 * message must travel through coordinator intake, the real agent loop/server EventLog,
 * syncDeliveryOutbox(), DeliveryDispatcher, and SlackDeliveryTarget before the fixed response appears.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import pino from 'pino';

import { createAgentServerApp } from '../../../packages/openhands-agent-server/src/app.js';
import type { LLMClient } from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/llm/client.js';
import { SlackBridge } from './adapter.js';

const runId = safeSegment(process.env.SMOLPAWS_CANARY_RUN_ID ?? randomUUID().slice(0, 8));
const root = path.resolve(
  process.env.SMOLPAWS_CANARY_ROOT ??
    path.join(homedir(), '.smolpaws', 'canary', 'slack-relay', runId),
);
const workspace = path.join(root, 'workspace');
const dbPath = process.env.SMOLPAWS_CANARY_DB ?? path.join(root, 'coordinator.db');
const response =
  process.env.SMOLPAWS_CANARY_RESPONSE?.trim() || `RELAY-LIVE-CANARY-${runId}`;
const port = positiveInteger(process.env.SMOLPAWS_CANARY_PORT ?? '8791', 'SMOLPAWS_CANARY_PORT');
const maxMs = positiveInteger(
  process.env.SMOLPAWS_CANARY_MAX_MS ?? String(10 * 60_000),
  'SMOLPAWS_CANARY_MAX_MS',
);
const sessionApiKey = process.env.SMOLPAWS_CANARY_SESSION_KEY ?? randomUUID();
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

mkdirSync(workspace, { recursive: true });
mkdirSync(path.dirname(dbPath), { recursive: true });

const server = await createAgentServerApp({
  logger: false,
  secretStore: memorySecretStore(),
  llmClientFactory: async (profile): Promise<LLMClient> => ({
    profile,
    complete: async () => ({
      message: {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: `finish-${runId}`,
            responses_item_id: null,
            name: 'finish',
            arguments: JSON.stringify({ message: response }),
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

const bridge = new SlackBridge({
  logger,
  serverUrl: `http://127.0.0.1:${port}`,
  sessionApiKey,
  dbPath,
  tickMs: 100,
  createConversationDefaults: {
    workspace: { kind: 'LocalWorkspace', working_dir: workspace },
    tags: { ingress: 'slack', canary: 'relay-live', run_id: runId },
  },
});

let stopping = false;
let stopTimer: ReturnType<typeof setTimeout> | undefined;

async function stop(reason: string, exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (stopTimer !== undefined) clearTimeout(stopTimer);
  logger.info({ reason, runId }, 'Stopping Slack Relay live canary');
  await bridge.stop().catch((error: unknown) => {
    logger.warn({ err: error }, 'Failed to stop Slack canary bridge cleanly');
  });
  await server.app.close().catch((error: unknown) => {
    logger.warn({ err: error }, 'Failed to stop Slack canary server cleanly');
  });
  writeStatus('stopped.json', { reason, exitCode, stoppedAt: new Date().toISOString() });
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal);
  });
}

try {
  await server.app.listen({ host: '127.0.0.1', port });
  await bridge.start();
  const status = {
    runId,
    pid: process.pid,
    commit: process.env.SMOLPAWS_CANARY_COMMIT ?? null,
    response,
    serverUrl: `http://127.0.0.1:${port}`,
    dbPath,
    startedAt: new Date().toISOString(),
    autoStopAfterMs: maxMs,
  };
  writeStatus('ready.json', status);
  logger.info(status, 'Slack Relay live canary ready');
  stopTimer = setTimeout(() => {
    void stop('automatic-timeout');
  }, maxMs);
  stopTimer.unref?.();
} catch (error) {
  logger.error({ err: error, runId }, 'Slack Relay live canary failed to start');
  writeStatus('failed.json', {
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  });
  await stop('startup-failure', 1);
}

function writeStatus(name: string, value: Record<string, unknown>): void {
  writeFileSync(
    path.join(root, name),
    `${JSON.stringify({ runId, ...value }, null, 2)}\n`,
    'utf8',
  );
}

function memorySecretStore() {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    has: async () => false,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (safe.length === 0) throw new Error('SMOLPAWS_CANARY_RUN_ID has no safe characters');
  return safe.slice(0, 80);
}
