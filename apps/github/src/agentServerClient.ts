import type {
  GithubEventPayload,
  SmolpawsQueueMessage,
} from '../../../src/shared/github.js';
import type {
  SmolpawsOutboundMessage,
} from '../../../src/shared/runner.js';
import {
  createDeliveryOwnerId,
  monitorTurn,
  submitConversationMessage,
} from '../../../src/shared/turnClient.js';

export type AgentServerEnv = {
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_SANDBOX_ID?: string;
};

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;
const GITHUB_MAX_ITERATIONS = 1000;

function normalizeValue(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeAgentServerBaseUrl(value?: string): string | null {
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  const withoutTrailingSlashes = normalized.replace(/\/+$/, '');
  if (withoutTrailingSlashes.endsWith('/run')) {
    throw new Error(
      'SMOLPAWS_RUNNER_URL must be the agent-server base URL and must not end with /run',
    );
  }
  return withoutTrailingSlashes;
}

function getMentionBody(payload: GithubEventPayload): string {
  return payload.comment?.body ?? payload.issue?.body ?? '';
}

function extractPromptFromComment(comment?: string | null): string {
  if (!comment) return '';
  return comment.replace(/@smolpaws/gi, '').trim();
}

function extractPromptFromPayload(payload: GithubEventPayload): string {
  return extractPromptFromComment(getMentionBody(payload));
}

function buildConversationId(message: SmolpawsQueueMessage): string {
  const repo = (message.payload.repository?.full_name ?? 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const threadNumber =
    message.payload.issue?.number ?? message.payload.pull_request?.number ?? 0;
  return `github-${repo}-${threadNumber}`;
}

function buildFallbackReply(message: SmolpawsQueueMessage): string {
  const actor = message.payload.sender?.login ?? 'there';
  const repo = message.payload.repository?.full_name ?? 'your repo';
  const trimmed = extractPromptFromPayload(message.payload);
  const requestLine = trimmed ? `Request: "${trimmed}"` : 'Request: (none)';
  return `🐾 Hey ${actor}! smolpaws is warming up in ${repo}.\n${requestLine}`;
}

const DAYTONA_DEFAULT_API_URL = 'https://app.daytona.io/api';
const SANDBOX_WAKE_POLL_MS = 3_000;
const SANDBOX_WAKE_MAX_WAIT_MS = 90_000;

function isDaytonaSandboxStopped(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('no ip address found') || msg.includes('is the sandbox started');
}

async function waitForSandboxReady(
  baseUrl: string,
  fetchImpl: typeof fetch,
  authToken?: string,
  timeoutMs = SANDBOX_WAKE_MAX_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetchImpl(`${baseUrl}/health`, { method: 'GET', headers });
      if (resp.ok) return true;
    } catch { /* sandbox still waking */ }
    await new Promise((r) => setTimeout(r, SANDBOX_WAKE_POLL_MS));
  }
  return false;
}

async function wakeDaytonaSandbox(
  env: AgentServerEnv,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const apiKey = normalizeValue(env.DAYTONA_API_KEY);
  const sandboxId = normalizeValue(env.DAYTONA_SANDBOX_ID);
  if (!apiKey || !sandboxId) {
    console.log('daytona.wake.skip', { reason: 'missing DAYTONA_API_KEY or DAYTONA_SANDBOX_ID' });
    return false;
  }

  const apiUrl = normalizeValue(env.DAYTONA_API_URL) ?? DAYTONA_DEFAULT_API_URL;
  const startUrl = `${apiUrl.replace(/\/+$/, '')}/sandbox/${encodeURIComponent(sandboxId)}/start`;

  console.log('daytona.wake.starting', { sandboxId });
  const resp = await fetchImpl(startUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.log('daytona.wake.error', { status: resp.status, body });
    return false;
  }

  const agentServerBaseUrl = normalizeAgentServerBaseUrl(env.SMOLPAWS_RUNNER_URL);
  if (!agentServerBaseUrl) return false;

  const ready = await waitForSandboxReady(agentServerBaseUrl, fetchImpl, env.SMOLPAWS_RUNNER_TOKEN);
  console.log('daytona.wake.result', { sandboxId, ready });
  return ready;
}

function collapseOutboundMessages(
  outboundMessages: SmolpawsOutboundMessage[],
): SmolpawsOutboundMessage[] {
  if (outboundMessages.length <= 1) {
    return outboundMessages;
  }

  return [
    {
      kind: 'current_thread_message',
      text: outboundMessages
        .map((outbound) => {
          if (outbound.kind !== 'current_thread_message') {
            throw new Error(`Unsupported outbound message kind: ${outbound.kind}`);
          }
          return outbound.text.trim();
        })
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

async function dispatchToAgentServerInner(
  message: SmolpawsQueueMessage,
  env: AgentServerEnv,
  fetchImpl: typeof fetch,
): Promise<{ reply?: string; outbound_messages?: SmolpawsOutboundMessage[] } | null> {
  const agentServerBaseUrl = normalizeAgentServerBaseUrl(env.SMOLPAWS_RUNNER_URL);
  if (!agentServerBaseUrl) {
    return null;
  }

  const prompt = extractPromptFromPayload(message.payload);
  if (!prompt) {
    return { reply: buildFallbackReply(message) };
  }

  const conversationId = buildConversationId(message);
  const deliveryOwnerId = createDeliveryOwnerId();
  const submitResult = await submitConversationMessage({
    baseUrl: agentServerBaseUrl,
    authToken: env.SMOLPAWS_RUNNER_TOKEN,
    conversationId,
    idempotencyKey: message.delivery_id ?? createDeliveryOwnerId(),
    deliveryOwnerId,
    fetchImpl,
    userMessage: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      run: true,
    },
    createConversation: {
      agent: {
        llm: {},
        tools: DEFAULT_AGENT_TOOLS,
      },
      confirmation_policy: {
        kind: 'NeverConfirm',
      },
      max_iterations: GITHUB_MAX_ITERATIONS,
      smolpaws: {
        ingress: message.meta?.ingress ?? 'github_webhook',
        enable_send_message: true,
        github: {
          event: message.event,
          repository_full_name: message.payload.repository?.full_name,
          owner_login: message.payload.repository?.owner?.login,
          actor_login: message.payload.sender?.login,
          issue_number: message.payload.issue?.number,
          pull_request_number: message.payload.pull_request?.number,
        },
      },
    },
  });

  const outboundMessages: SmolpawsOutboundMessage[] = [];
  const monitored = await monitorTurn({
    baseUrl: agentServerBaseUrl,
    authToken: env.SMOLPAWS_RUNNER_TOKEN,
    conversationId: submitResult.conversation_id,
    turnId: submitResult.turn_id,
    deliveryOwnerId,
    isDeliveryOwner: submitResult.is_delivery_owner,
    fetchImpl,
    onOutboundMessage: async (outboundMessage) => {
      outboundMessages.push(outboundMessage);
    },
  });
  return {
    reply:
      monitored.reply ??
      (!submitResult.is_delivery_owner || outboundMessages.length > 0
        ? undefined
        : buildFallbackReply(message)),
    outbound_messages:
      outboundMessages.length > 0
        ? collapseOutboundMessages(outboundMessages)
        : undefined,
  };
}

export async function dispatchToAgentServer(
  message: SmolpawsQueueMessage,
  env: AgentServerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reply?: string; outbound_messages?: SmolpawsOutboundMessage[] } | null> {
  try {
    return await dispatchToAgentServerInner(message, env, fetchImpl);
  } catch (error) {
    if (!isDaytonaSandboxStopped(error)) throw error;

    console.log('daytona.sandbox.stopped', { error: String(error) });
    const woke = await wakeDaytonaSandbox(env, fetchImpl);
    if (!woke) throw error;

    return await dispatchToAgentServerInner(message, env, fetchImpl);
  }
}
