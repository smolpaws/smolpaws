import path from 'path';
import pino from 'pino';
import { GROUPS_DIR } from '../config.js';
import type { ExecutionScope } from '../scope.js';
import type { ContainerInput, ContainerOutput } from '../container-runner.js';
import { buildVisibleTaskSnapshot, processSharedRunnerTaskCommand } from '../task-commands.js';
import type { RegisteredGroup } from '../types.js';

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

type SharedRunnerOutput = ContainerOutput & {
  outboundMessages?: RunnerOutboundMessage[];
};

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

function getRunnerBaseUrl(): string {
  const value = process.env.SMOLPAWS_RUNNER_URL?.trim();
  if (!value) {
    throw new Error('SMOLPAWS_RUNNER_URL is required for shared-runner backend');
  }
  return value.endsWith('/') ? value : `${value}/`;
}

function buildRunnerHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = process.env.SMOLPAWS_RUNNER_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildRunnerLlmRequest(): {
  provider?: string;
  model: string;
  base_url?: string;
  api_key?: string;
} {
  const model = (process.env.LLM_MODEL ?? process.env.MODEL ?? '').trim();
  if (!model) {
    throw new Error('LLM_MODEL or MODEL is required for shared-runner backend');
  }
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  return {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
    model,
    base_url: process.env.LLM_BASE_URL,
    api_key: apiKey,
  };
}

function buildWorkspaceRoot(scope: ExecutionScope): string {
  return path.join(GROUPS_DIR, scope.workspaceFolder);
}

function buildPrompt(input: ContainerInput): string {
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

async function fetchJson<T>(
  pathname: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(pathname, getRunnerBaseUrl()), init);
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
  input: ContainerInput,
): Promise<RunnerConversationInfo> {
  return await fetchJson<RunnerConversationInfo>('/api/conversations', {
    method: 'POST',
    headers: buildRunnerHeaders(),
    body: JSON.stringify({
      agent: {
        llm: buildRunnerLlmRequest(),
      },
      workspace: {
        kind: 'local',
        working_dir: buildWorkspaceRoot(scope),
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
      headers: buildRunnerHeaders(),
    },
  );
}

async function claimConversationTaskCommands(
  conversationId: string,
): Promise<RunnerTaskCommand[]> {
  return await fetchJson<RunnerTaskCommand[]>(
    `/api/conversations/${conversationId}/task_commands/claim`,
    {
      method: 'POST',
      headers: buildRunnerHeaders(),
    },
  );
}

async function loadLatestAssistantReply(
  conversationId: string,
): Promise<string | null> {
  const page = await fetchJson<RunnerEventPage>(
    `/api/conversations/${conversationId}/events/search?source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      method: 'GET',
      headers: buildRunnerHeaders(),
    },
  );
  return extractLatestAssistantReply(page);
}

export async function runSharedRunnerAgent(
  scope: ExecutionScope,
  input: ContainerInput,
  options?: {
    registeredGroups?: Record<string, RegisteredGroup>;
  },
): Promise<SharedRunnerOutput> {
  const conversation = await createOrContinueConversation(scope, input);
  const outboundMessages = await claimConversationOutbox(conversation.id);
  const taskCommands = await claimConversationTaskCommands(conversation.id);
  for (const command of taskCommands) {
    processSharedRunnerTaskCommand(
      command,
      scope.scopeId,
      options?.registeredGroups ?? {},
      logger,
    );
  }
  const result = await loadLatestAssistantReply(conversation.id);
  return {
    status: 'success',
    result,
    conversationId: conversation.id,
    outboundMessages: outboundMessages.length ? outboundMessages : undefined,
  };
}
