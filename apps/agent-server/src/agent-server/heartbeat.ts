import os from 'node:os';
import path from 'node:path';
import type { StartConversationRequest } from './models.js';

export const DEFAULT_HEARTBEAT_RUNNER_HOST = '127.0.0.1';
export const DEFAULT_HEARTBEAT_RUNNER_PORT = '8788';
export const DEFAULT_HEARTBEAT_CRON = '0 * * * *';
export const DEFAULT_HEARTBEAT_MAX_ITERATIONS = 500;

type HeartbeatPaths = {
  docsDir: string;
  memoryFile: string;
  dailyMemoryDir: string;
  heartbeatStateFile: string;
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
  return {
    docsDir,
    memoryFile: path.join(docsDir, 'MEMORY.md'),
    dailyMemoryDir: path.join(docsDir, 'memory'),
    heartbeatStateFile: path.join(docsDir, 'memory', 'heartbeat-state.json'),
  };
}

export function buildHeartbeatConversationId(now: Date): string {
  return `heartbeat-smolpaws-${formatLocalDate(now)}-${formatLocalTime(now)}`;
}

export function buildHeartbeatPrompt(paths: HeartbeatPaths, now: Date): string {
  return [
    'This is a scheduled local heartbeat turn for SmolPaws.',
    `Read HEARTBEAT.md in the canonical self/context directory: ${paths.docsDir}`,
    `Durable memory lives at: ${paths.memoryFile}`,
    `Daily memory directory: ${paths.dailyMemoryDir}`,
    `Heartbeat state file: ${paths.heartbeatStateFile}`,
    `Today is: ${formatLocalDate(now)}`,
    'Carry out the heartbeat checklist quietly.',
    'Do not send outbound messages.',
    'If nothing needs attention, make only the minimal state updates and finish.',
  ].join('\n');
}

export function buildHeartbeatRequest(now: Date): StartConversationRequest {
  const paths = buildHeartbeatPaths();
  return {
    conversation_id: buildHeartbeatConversationId(now),
    agent: {
      llm: {},
    },
    workspace: {
      kind: 'local',
      working_dir: process.env.SMOLPAWS_DEFAULT_WORKING_DIR?.trim() || 'smolpaws',
    },
    max_iterations: DEFAULT_HEARTBEAT_MAX_ITERATIONS,
    initial_message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildHeartbeatPrompt(paths, now),
        },
      ],
    },
    smolpaws: {
      ingress: 'heartbeat',
      scope_id: 'heartbeat-local',
      is_control_scope: true,
      enable_send_message: false,
      enable_task_tools: false,
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
