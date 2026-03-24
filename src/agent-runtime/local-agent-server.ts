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
import { ensureLocalRunnerReady } from './local-runner.js';

type RunnerConversationInfo = {
  id: string;
  execution_status?: string;
};

type RunnerEventPage = {
  items: Array<{
    kind?: string;
    code?: string;
    detail?: string;
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
const WHATSAPP_MAX_ITERATIONS = 5000;
const MAX_ITERATIONS_EXCEEDED = 'max_iterations_exceeded';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

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
  const token = process.env.SMOLPAWS_RUNNER_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson<T>(baseUrl: string, pathname: string, init: RequestInit): Promise<T> {
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

function extractConversationResult(page: RunnerEventPage): {
  reply: string | null;
  errorCode?: string;
  errorDetail?: string;
} {
  for (const event of page.items) {
    if (event.kind === 'ConversationErrorEvent') {
      return {
        reply: null,
        errorCode: event.code,
        errorDetail: event.detail,
      };
    }
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
      return { reply: text };
    }
  }
  return { reply: null };
}

async function createOrContinueConversation(
  baseUrl: string,
  scope: ExecutionScope,
  input: AgentRuntimeInput,
): Promise<RunnerConversationInfo> {
  return await fetchJson<RunnerConversationInfo>(baseUrl, '/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: {
        llm: {},
        tools: DEFAULT_AGENT_TOOLS,
      },
      confirmation_policy: {
        kind: 'NeverConfirm',
      },
      workspace: {
        kind: 'local',
        working_dir: buildConversationWorkingDir(scope),
      },
      max_iterations: WHATSAPP_MAX_ITERATIONS,
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

async function loadConversationInfo(
  baseUrl: string,
  conversationId: string,
): Promise<RunnerConversationInfo | null> {
  const infos = await fetchJson<Array<RunnerConversationInfo | null>>(
    baseUrl,
    `/api/conversations?ids=${encodeURIComponent(conversationId)}`,
    {
      method: 'GET',
    },
  );
  return infos[0] ?? null;
}

async function claimConversationOutbox(
  baseUrl: string,
  conversationId: string,
): Promise<RunnerOutboundMessage[]> {
  return await fetchJson<RunnerOutboundMessage[]>(
    baseUrl,
    `/api/conversations/${conversationId}/outbound_messages/claim`,
    {
      method: 'POST',
    },
  );
}

async function claimConversationTaskCommands(
  baseUrl: string,
  conversationId: string,
): Promise<SharedRunnerTaskCommand[]> {
  return await fetchJson<SharedRunnerTaskCommand[]>(
    baseUrl,
    `/api/conversations/${conversationId}/task_commands/claim`,
    {
      method: 'POST',
    },
  );
}

async function loadConversationResult(
  baseUrl: string,
  conversationId: string,
): Promise<{ reply: string | null; errorCode?: string; errorDetail?: string }> {
  const page = await fetchJson<RunnerEventPage>(
    baseUrl,
    `/api/conversations/${conversationId}/events/search?source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      method: 'GET',
    },
  );
  return extractConversationResult(page);
}

export async function runLocalAgentServerAgent(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<AgentRuntimeOutput> {
  try {
    const baseUrl = await ensureLocalRunnerReady();
    if (input.conversationId) {
      try {
        const existing = await loadConversationInfo(baseUrl, input.conversationId);
        if (existing?.execution_status === 'waiting_for_confirmation') {
          logger.warn(
            { scopeId: scope.scopeId, conversationId: input.conversationId },
            'Local WhatsApp conversation is waiting for confirmation; starting a fresh conversation',
          );
          input = { ...input, conversationId: undefined };
        }
      } catch (error) {
        logger.warn(
          { scopeId: scope.scopeId, conversationId: input.conversationId, error },
          'Failed to inspect conversation status; continuing with provided conversationId',
        );
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conversation = await createOrContinueConversation(baseUrl, scope, input);
      const taskCommands = await claimConversationTaskCommands(baseUrl, conversation.id);
      for (const command of taskCommands) {
        processSharedRunnerTaskCommand(
          command,
          scope.scopeId,
          options?.registeredGroups ?? {},
          logger,
        );
      }

      const outboundMessages = await claimConversationOutbox(baseUrl, conversation.id);
      if (outboundMessages.length > 0) {
        return {
          status: 'success',
          result: null,
          conversationId: conversation.id,
          outboundMessages,
        };
      }

      const result = await loadConversationResult(baseUrl, conversation.id);
      if (result.errorCode === MAX_ITERATIONS_EXCEEDED && input.conversationId && attempt === 0) {
        logger.warn(
          { scopeId: scope.scopeId, conversationId: input.conversationId },
          'Local WhatsApp conversation exhausted; starting a fresh conversation',
        );
        input = { ...input, conversationId: undefined };
        continue;
      }

      if (result.errorCode) {
        return {
          status: 'error',
          result: null,
          conversationId: conversation.id,
          error: result.errorDetail ?? result.errorCode,
        };
      }

      return {
        status: 'success',
        result: result.reply,
        conversationId: conversation.id,
      };
    }

    return {
      status: 'error',
      result: null,
      conversationId: input.conversationId,
      error: 'Unable to continue or restart the local WhatsApp conversation.',
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
