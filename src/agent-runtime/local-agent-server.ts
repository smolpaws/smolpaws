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

type LocalRunnerAttemptResult = AgentRuntimeOutput & {
  errorCode?: string;
};

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;
const WHATSAPP_MAX_ITERATIONS = 5000;

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

function isRetryableRunnerFetchError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('fetch failed');
}

function formatRetryableRunnerFetchError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function retryPostRunFetch<T>(
  baseUrl: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isRetryableRunnerFetchError(error)) {
      throw error;
    }
    logger.warn(
      { baseUrl, operation, error: formatRetryableRunnerFetchError(error) },
      'Transient runner fetch failed; retrying once',
    );
    await ensureLocalRunnerReady();
    return await action();
  }
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

async function executeConversationAttempt(
  baseUrl: string,
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<LocalRunnerAttemptResult> {
  const conversation = await createOrContinueConversation(baseUrl, scope, input);
  const taskCommands = await retryPostRunFetch(
    baseUrl,
    'claim task commands',
    () => claimConversationTaskCommands(baseUrl, conversation.id),
  );
  for (const command of taskCommands) {
    processSharedRunnerTaskCommand(
      command,
      scope.scopeId,
      options?.registeredGroups ?? {},
      logger,
    );
  }

  const outboundMessages = await retryPostRunFetch(
    baseUrl,
    'claim outbound messages',
    () => claimConversationOutbox(baseUrl, conversation.id),
  );
  if (outboundMessages.length > 0) {
    return {
      status: 'success',
      conversationId: conversation.id,
      result: null,
      outboundMessages,
    };
  }

  const result = await retryPostRunFetch(
    baseUrl,
    'load conversation result',
    () => loadConversationResult(baseUrl, conversation.id),
  );
  if (result.errorCode) {
    return {
      status: 'error',
      result: null,
      conversationId: conversation.id,
      error: result.errorDetail ?? result.errorCode,
      errorCode: result.errorCode,
    };
  }

  return {
    status: 'success',
    result: result.reply,
    conversationId: conversation.id,
  };
}

export async function runLocalAgentServerAgent(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<AgentRuntimeOutput> {
  try {
    const baseUrl = await ensureLocalRunnerReady();
    const firstAttempt = await executeConversationAttempt(baseUrl, scope, input, options);
    if (firstAttempt.status === 'error'
      && input.conversationId
      && firstAttempt.errorCode === 'max_iterations_exceeded') {
      logger.warn(
        { scopeId: scope.scopeId, conversationId: input.conversationId },
        'Reused conversation hit max iterations; starting a fresh conversation',
      );
      return await executeConversationAttempt(baseUrl, scope, {
        ...input,
        conversationId: undefined,
      }, options);
    }

    return firstAttempt;
  } catch (error) {
    return {
      status: 'error',
      result: null,
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
