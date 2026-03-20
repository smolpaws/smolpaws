import net from 'node:net';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  Workspace,
  isAgentServerWorkspace,
  type AgentServerWorkspace,
} from '@smolpaws/agent-sdk';
import type { ExecutionScope } from '../scope.js';
import type { AgentRuntimeInput, AgentRuntimeOutput } from './types.js';
import { buildVisibleTaskSnapshot, processSharedRunnerTaskCommand } from '../task-commands.js';
import type { RegisteredGroup } from '../types.js';
import { buildRunnerHostMounts } from './workspace.js';

type RunnerConversationInfo = {
  id: string;
};

type RunnerEventPage = {
  items: Array<{
    kind?: string;
    source?: string;
    llm_message?: {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  }>;
};

type RunnerOutboundMessage = {
  kind: 'current_thread_message';
  text: string;
};

type RunnerTaskCommand =
  | {
      kind: 'schedule_task';
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode: 'group' | 'isolated';
      target_scope_id?: string;
      source_scope_id?: string;
    }
  | {
      kind: 'pause_task' | 'resume_task' | 'cancel_task';
      task_id: string;
      source_scope_id?: string;
    };

type SharedRunnerOutput = AgentRuntimeOutput & {
  outboundMessages?: RunnerOutboundMessage[];
};

const DEFAULT_RUNNER_IMAGE = 'smolpaws-runner:latest';
const DEFAULT_RUNNER_ROOT = '/workspace';
const DEFAULT_RUNNER_WORKING_DIR = '/workspace/group';
const DEFAULT_RUNNER_PERSISTENCE_DIR = '/workspace/persistence';
const DEFAULT_RUNNER_CONTAINER_PORT = 8788;
const DEFAULT_RUNNER_PORT_BASE = 41000;
const RUNNER_FORWARD_ENV = [
  'LLM_MODEL',
  'MODEL',
  'LLM_API_KEY',
  'ANTHROPIC_API_KEY',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'SMOLPAWS_RUNNER_TOKEN',
  'SMOLPAWS_WORKSPACE_ROOT',
  'SMOLPAWS_PERSISTENCE_DIR',
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const workspaceCache = new Map<string, AgentServerWorkspace>();
let nextRunnerPort = Number.parseInt(
  process.env.SMOLPAWS_RUNNER_PORT_BASE ?? `${DEFAULT_RUNNER_PORT_BASE}`,
  10,
);

function resolveRunnerImage(): string {
  const image = process.env.SMOLPAWS_RUNNER_IMAGE?.trim();
  return image || DEFAULT_RUNNER_IMAGE;
}

function resolveRunnerToken(): string {
  const token = process.env.SMOLPAWS_RUNNER_TOKEN?.trim();
  if (token) {
    return token;
  }
  const generated = randomUUID();
  process.env.SMOLPAWS_RUNNER_TOKEN = generated;
  return generated;
}

function ensureRunnerEnvDefaults(): void {
  resolveRunnerToken();
  process.env.SMOLPAWS_WORKSPACE_ROOT ||= DEFAULT_RUNNER_ROOT;
  process.env.SMOLPAWS_PERSISTENCE_DIR ||= DEFAULT_RUNNER_PERSISTENCE_DIR;
}

function buildRunnerLlmRequest(): {
  provider?: string;
  model: string;
  base_url?: string;
  api_key?: string;
} {
  const model = (process.env.LLM_MODEL ?? process.env.MODEL ?? '').trim();
  if (!model) {
    throw new Error('LLM_MODEL or MODEL is required for the runner workspace');
  }
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  return {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
    model,
    base_url: process.env.LLM_BASE_URL,
    api_key: apiKey,
  };
}

function buildPrompt(input: AgentRuntimeInput): string {
  if (!input.isScheduledTask) {
    return input.prompt;
  }
  return `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use send_message if needed to communicate with the user.]\n\n${input.prompt}`;
}

function buildSmolpawsConfig(scope: ExecutionScope) {
  return {
    ingress: 'whatsapp',
    scope_id: scope.scopeId,
    is_control_scope: scope.isControlScope,
    enable_send_message: true,
    enable_task_tools: true,
    visible_tasks: buildVisibleTaskSnapshot(scope.scopeId),
  };
}

function buildConversationWorkingDir(): string {
  return DEFAULT_RUNNER_WORKING_DIR;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function reserveRunnerPort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = nextRunnerPort;
    nextRunnerPort += 1;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error('No available host port found for shared-runner workspace');
}

async function getWorkspaceForScope(scope: ExecutionScope): Promise<AgentServerWorkspace> {
  const existing = workspaceCache.get(scope.scopeId);
  if (existing) {
    try {
      await existing.isAlive();
      return existing;
    } catch (error) {
      logger.warn(
        { scopeId: scope.scopeId, error: error instanceof Error ? error.message : String(error) },
        'Recreating shared-runner workspace after failed health check',
      );
      workspaceCache.delete(scope.scopeId);
    }
  }

  ensureRunnerEnvDefaults();
  const hostPort = await reserveRunnerPort();
  const workspace = Workspace({
    kind: 'apple',
    root: DEFAULT_RUNNER_ROOT,
    hostPort,
    serverPort: DEFAULT_RUNNER_CONTAINER_PORT,
    serverImage: resolveRunnerImage(),
    volumes: buildRunnerHostMounts(scope, scope.isControlScope),
    forwardEnv: RUNNER_FORWARD_ENV,
    runtimeSessionApiKey: resolveRunnerToken(),
    containerBinary: process.env.SMOLPAWS_CONTAINER_BINARY,
  });

  if (!isAgentServerWorkspace(workspace) || workspace.kind !== 'apple') {
    throw new Error('Expected Workspace() to return an AppleWorkspace-backed agent-server workspace');
  }
  await workspace.isAlive();
  workspaceCache.set(scope.scopeId, workspace);
  return workspace;
}

function mergeHeaders(
  workspace: AgentServerWorkspace,
  extra: Record<string, string> = {},
): Record<string, string> {
  return workspace.getAuthHeaders(extra);
}

async function fetchJson<T>(
  workspace: AgentServerWorkspace,
  pathname: string,
  init: RequestInit,
): Promise<T> {
  const headers = mergeHeaders(
    workspace,
    (init.headers as Record<string, string> | undefined) ?? {},
  );
  const response = await fetch(new URL(pathname, workspace.getServerUrl()), {
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner request failed (${response.status}): ${text}`);
  }
  return await response.json() as T;
}

function extractLatestAssistantReply(page: RunnerEventPage): string | null {
  for (const event of page.items) {
    if (event.kind !== 'MessageEvent' || event.llm_message?.role !== 'assistant') {
      continue;
    }
    const text = (event.llm_message.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  return null;
}

async function createOrContinueConversation(
  workspace: AgentServerWorkspace,
  scope: ExecutionScope,
  input: AgentRuntimeInput,
): Promise<RunnerConversationInfo> {
  return await fetchJson<RunnerConversationInfo>(workspace, '/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: {
        llm: buildRunnerLlmRequest(),
      },
      workspace: {
        kind: 'local',
        working_dir: buildConversationWorkingDir(),
      },
      max_iterations: 100,
      conversation_id: input.conversationId,
      initial_message: {
        role: 'user',
        content: [{ type: 'text', text: buildPrompt(input) }],
        run: true,
      },
      smolpaws: buildSmolpawsConfig(scope),
    }),
  });
}

async function claimConversationOutbox(
  workspace: AgentServerWorkspace,
  conversationId: string,
): Promise<RunnerOutboundMessage[]> {
  return await fetchJson<RunnerOutboundMessage[]>(
    workspace,
    `/api/conversations/${conversationId}/outbound_messages/claim`,
    {
      method: 'POST',
    },
  );
}

async function claimConversationTaskCommands(
  workspace: AgentServerWorkspace,
  conversationId: string,
): Promise<RunnerTaskCommand[]> {
  return await fetchJson<RunnerTaskCommand[]>(
    workspace,
    `/api/conversations/${conversationId}/task_commands/claim`,
    {
      method: 'POST',
    },
  );
}

async function loadLatestAssistantReply(
  workspace: AgentServerWorkspace,
  conversationId: string,
): Promise<string | null> {
  const page = await fetchJson<RunnerEventPage>(
    workspace,
    `/api/conversations/${conversationId}/events/search?source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      method: 'GET',
    },
  );
  return extractLatestAssistantReply(page);
}

export async function runSharedRunnerAgent(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: {
    registeredGroups?: Record<string, RegisteredGroup>;
  },
): Promise<SharedRunnerOutput> {
  const workspace = await getWorkspaceForScope(scope);
  const conversation = await createOrContinueConversation(workspace, scope, input);
  const outboundMessages = await claimConversationOutbox(workspace, conversation.id);
  const taskCommands = await claimConversationTaskCommands(workspace, conversation.id);
  for (const command of taskCommands) {
    processSharedRunnerTaskCommand(
      command,
      scope.scopeId,
      options?.registeredGroups ?? {},
      logger,
    );
  }
  const result = await loadLatestAssistantReply(workspace, conversation.id);
  return {
    status: 'success',
    result,
    conversationId: conversation.id,
    outboundMessages: outboundMessages.length ? outboundMessages : undefined,
  };
}
