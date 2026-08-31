import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HEARTBEAT_RUNNER_HOST = '127.0.0.1';
// The heartbeat targets the new transpiled agent-server (packages/openhands-agent-server),
// which runs on 8790 by default — not the legacy runner on 8788.
export const DEFAULT_HEARTBEAT_RUNNER_PORT = '8790';
export const DEFAULT_HEARTBEAT_CRON = '0 * * * *';
export const DEFAULT_HEARTBEAT_MAX_ITERATIONS = 500;
// LLM profile the heartbeat runs on. Must be registered on the new server
// (POST /api/profiles). Overridable via SMOLPAWS_HEARTBEAT_PROFILE.
export const DEFAULT_HEARTBEAT_PROFILE = 'deepseek-v4-pro';

/**
 * Request body for the new agent-server's `POST /api/conversations`. Kept as a local, minimal
 * shape (not the legacy TypeBox `StartConversationRequest`): the new server is profile-first and
 * uses `agent_kind` + `llm_profile_ref`, a `LocalWorkspace` kind, and a UUID `conversation_id`.
 */
export interface HeartbeatConversationRequest {
  conversation_id: string;
  agent: { agent_kind: 'openhands'; llm_profile_ref: string };
  workspace: { kind: 'LocalWorkspace'; working_dir: string };
  max_iterations: number;
  initial_message: { role: 'user'; content: string };
}

type HeartbeatPaths = {
  docsDir: string;
  memoryFile: string;
  dailyMemoryDir: string;
  heartbeatStateFile: string;
  conversationArchiveDir: string;
};

function formatLocalDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalTime(now: Date): string {
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}-${minutes}-${seconds}`;
}

export function buildHeartbeatPaths(homeDir = os.homedir()): HeartbeatPaths {
  const docsDir = path.join(homeDir, 'repos', 'smolpaws', 'docs', 'smolpaws');
  const smolpawsHomeDir =
    process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homeDir, '.smolpaws');
  return {
    docsDir,
    memoryFile: path.join(docsDir, 'MEMORY.md'),
    dailyMemoryDir: path.join(smolpawsHomeDir, 'memory'),
    heartbeatStateFile: path.join(smolpawsHomeDir, 'memory', 'heartbeat-state.json'),
    conversationArchiveDir:
      process.env.SMOLPAWS_CONVERSATIONS_DIR?.trim() ||
      path.join(homeDir, '.openhands', 'conversations'),
  };
}

// Fixed namespace for deterministic heartbeat conversation ids (a random UUID, constant forever).
const HEARTBEAT_ID_NAMESPACE = '6f4b3d2a-1c9e-4a7b-8f0d-2e5c1a9b7d63';

/**
 * Deterministic UUIDv5 of `heartbeat-smolpaws-<local-date>`. The new agent-server requires a UUID
 * `conversation_id` and reuses an existing one, so a stable per-day UUID preserves the heartbeat's
 * "one conversation per local day, reuse within the day" behavior.
 */
export function buildHeartbeatConversationId(now: Date): string {
  return uuidV5(`heartbeat-smolpaws-${formatLocalDate(now)}`, HEARTBEAT_ID_NAMESPACE);
}

/** Minimal RFC-4122 v5 (SHA-1, name-based) UUID. */
function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(name).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildHeartbeatPrompt(paths: HeartbeatPaths, now: Date): string {
  return [
    'This is a scheduled local heartbeat turn for SmolPaws.',
    `Read HEARTBEAT.md in the canonical self/context directory: ${paths.docsDir}`,
    `Durable memory lives at: ${paths.memoryFile}`,
    `Daily memory directory: ${paths.dailyMemoryDir}`,
    `Heartbeat state file: ${paths.heartbeatStateFile}`,
    `Conversation archive directory: ${paths.conversationArchiveDir}`,
    `Today is: ${formatLocalDate(now)}`,
    'For Slack checks, do not silently narrow the required channel set.',
    'Check mentions in the full joined-channel set: general (C06P5NCGSFP), random (C06PB3T5ZK6), questions (C06U8UTKSAD), slackbot-chatter (C091TN9PPJ9), success-stories (C07KHERRM2S), and proj-agent (C06R25BT5B2).',
    'Check recent thread replies across that same channel set where smolpaws has posted recently, not just a smaller subset.',
    'Carry out the heartbeat checklist quietly.',
    'Do not send outbound messages.',
    'If nothing needs attention, make only the minimal state updates and finish.',
  ].join('\n');
}

export function buildHeartbeatRequest(now: Date): HeartbeatConversationRequest {
  const paths = buildHeartbeatPaths();
  return {
    conversation_id: buildHeartbeatConversationId(now),
    agent: {
      agent_kind: 'openhands',
      llm_profile_ref: process.env.SMOLPAWS_HEARTBEAT_PROFILE?.trim() || DEFAULT_HEARTBEAT_PROFILE,
    },
    workspace: {
      kind: 'LocalWorkspace',
      working_dir: process.env.SMOLPAWS_DEFAULT_WORKING_DIR?.trim() || 'smolpaws',
    },
    max_iterations: DEFAULT_HEARTBEAT_MAX_ITERATIONS,
    // The new server accepts a plain string as message content. The heartbeat prompt itself
    // instructs the agent not to send outbound messages, so no send_message tool is requested.
    initial_message: {
      role: 'user',
      content: buildHeartbeatPrompt(paths, now),
    },
  };
}

export function resolveHeartbeatRunnerBaseUrl(env = process.env): string {
  const explicit = env.SMOLPAWS_RUNNER_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const host = env.RUNNER_HOST?.trim() || DEFAULT_HEARTBEAT_RUNNER_HOST;
  const port = env.PORT?.trim() || DEFAULT_HEARTBEAT_RUNNER_PORT;
  return `http://${host}:${port}`;
}
