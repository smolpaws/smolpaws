import path from 'path';
import { GROUPS_DIR } from '../config.js';
import type { ExecutionScope } from '../scope.js';
import type { ContainerInput, ContainerOutput } from '../container-runner.js';

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

type SharedRunnerOutput = ContainerOutput & {
  outboundMessages?: RunnerOutboundMessage[];
};

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
      smolpaws: {
        ingress: 'whatsapp',
        scope_id: scope.scopeId,
        is_control_scope: scope.isControlScope,
        enable_send_message: true,
      },
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
): Promise<SharedRunnerOutput> {
  const conversation = await createOrContinueConversation(scope, input);
  const outboundMessages = await claimConversationOutbox(conversation.id);
  const result = await loadLatestAssistantReply(conversation.id);
  return {
    status: 'success',
    result,
    conversationId: conversation.id,
    outboundMessages: outboundMessages.length ? outboundMessages : undefined,
  };
}
