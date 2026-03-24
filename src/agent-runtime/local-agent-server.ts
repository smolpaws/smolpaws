import path from 'node:path';
import pino from 'pino';
import type { ExecutionScope } from '../scope.js';
import type { RegisteredGroup } from '../types.js';
import type { AgentRuntimeInput, AgentRuntimeOutput } from './types.js';
import { GROUPS_DIR } from '../config.js';
import {
  buildVisibleTaskSnapshot,
  processSharedRunnerTaskCommand,
  type SharedRunnerTaskCommand,
} from '../task-commands.js';

type RunnerConversationInfo = {
  id: string;
};

type RunnerEventPage = {
  items: Array<{
    kind?: string;
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

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;

const DEFAULT_RUNNER_HOST = '127.0.0.1';
const DEFAULT_RUNNER_PORT = '8788';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

function normalizeValue(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveRunnerBaseUrl(): string {
  const explicit = normalizeValue(process.env.SMOLPAWS_RUNNER_URL);
  if (explicit) {
    const normalized = explicit.replace(/\/+$/, '');
    if (normalized.endsWith('/run')) {
      throw new Error(
        'SMOLPAWS_RUNNER_URL must be the agent-server base URL and must not end with /run',
      );
    }
    return normalized;
  }

  const host = normalizeValue(process.env.RUNNER_HOST) ?? DEFAULT_RUNNER_HOST;
  const port = normalizeValue(process.env.PORT) ?? DEFAULT_RUNNER_PORT;
  return `http://${host}:${port}`;
}

function buildPrompt(input: AgentRuntimeInput): string {
  if (!input.isScheduledTask) {
    return input.prompt;
  }
  return `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use send_message if needed to communicate with the user.]\n\n${input.prompt}`;
}

function buildConversationWorkingDir(scope: ExecutionScope): string {
  return path.join(GROUPS_DIR, scope.workspaceFolder);
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

function buildHeaders(additional: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...additional };
  const token = normalizeValue(process.env.SMOLPAWS_RUNNER_TOKEN);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson<T>(pathname: string, init: RequestInit): Promise<T> {
  const baseUrl = resolveRunnerBaseUrl();
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: buildHeaders((init.headers as Record<string, string> | undefined) ?? {}),
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
  scope: ExecutionScope,
  input: AgentRuntimeInput,
): Promise<RunnerConversationInfo> {
  return await fetchJson<RunnerConversationInfo>('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: {
        llm: {},
        tools: DEFAULT_AGENT_TOOLS,
      },
      workspace: {
        kind: 'local',
        working_dir: buildConversationWorkingDir(scope),
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
  conversationId: string,
): Promise<RunnerOutboundMessage[]> {
  return await fetchJson<RunnerOutboundMessage[]>(
    `/api/conversations/${conversationId}/outbound_messages/claim`,
    {
      method: 'POST',
    },
  );
}

async function claimConversationTaskCommands(
  conversationId: string,
): Promise<SharedRunnerTaskCommand[]> {
  return await fetchJson<SharedRunnerTaskCommand[]>(
    `/api/conversations/${conversationId}/task_commands/claim`,
    {
      method: 'POST',
    },
  );
}

async function loadLatestAssistantReply(conversationId: string): Promise<string | null> {
  const page = await fetchJson<RunnerEventPage>(
    `/api/conversations/${conversationId}/events/search?source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      method: 'GET',
    },
  );
  return extractLatestAssistantReply(page);
}

export async function runLocalAgentServerAgent(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<AgentRuntimeOutput> {
  try {
    const conversation = await createOrContinueConversation(scope, input);
    const taskCommands = await claimConversationTaskCommands(conversation.id);
    for (const command of taskCommands) {
      processSharedRunnerTaskCommand(
        command,
        scope.scopeId,
        options?.registeredGroups ?? {},
        logger,
      );
    }

    const outboundMessages = await claimConversationOutbox(conversation.id);
    if (outboundMessages.length > 0) {
      return {
        status: 'success',
        result: null,
        conversationId: conversation.id,
        outboundMessages,
      };
    }

    const reply = await loadLatestAssistantReply(conversation.id);
    return {
      status: 'success',
      result: reply,
      conversationId: conversation.id,
    };
  } catch (error) {
    return {
      status: 'error',
      result: null,
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
