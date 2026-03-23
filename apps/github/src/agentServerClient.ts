import type {
  GithubEventPayload,
  SmolpawsQueueMessage,
} from '../../agent-server/src/shared/github.js';
import type {
  SmolpawsOutboundMessage,
} from '../../agent-server/src/shared/runner.js';

export type AgentServerEnv = {
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
};

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;

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

function extractAssistantReplyFromEventPage(data: unknown): string | null {
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { items?: unknown[] }).items)
  ) {
    return null;
  }
  for (const item of (data as { items: unknown[] }).items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const event = item as {
      kind?: unknown;
      llm_message?: {
        role?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
    };
    if (event.kind !== 'MessageEvent' || event.llm_message?.role !== 'assistant') {
      continue;
    }
    const text = (event.llm_message.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => (part.text as string).trim())
      .filter(Boolean)
      .join('\n');
    if (text) {
      return text;
    }
  }
  return null;
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

export async function dispatchToAgentServer(
  message: SmolpawsQueueMessage,
  env: AgentServerEnv,
  fetchImpl: typeof fetch = fetch,
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
  const response = await fetchImpl(`${agentServerBaseUrl}/api/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.SMOLPAWS_RUNNER_TOKEN
        ? { Authorization: `Bearer ${env.SMOLPAWS_RUNNER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      agent: {
        llm: {},
        tools: DEFAULT_AGENT_TOOLS,
      },
      conversation_id: conversationId,
      initial_message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        run: true,
      },
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
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Agent-server error: ${responseText}`);
  }

  const data = (await response.json()) as { id?: unknown };
  if (typeof data.id !== 'string' || !data.id.trim()) {
    throw new Error('Agent-server response missing conversation id');
  }

  const claimedMessagesResponse = await fetchImpl(
    `${agentServerBaseUrl}/api/conversations/${encodeURIComponent(data.id)}/outbound_messages/claim`,
    {
      method: 'POST',
      headers: env.SMOLPAWS_RUNNER_TOKEN
        ? { Authorization: `Bearer ${env.SMOLPAWS_RUNNER_TOKEN}` }
        : {},
    },
  );
  if (!claimedMessagesResponse.ok) {
    const responseText = await claimedMessagesResponse.text();
    throw new Error(`Agent-server outbound claim error: ${responseText}`);
  }
  const outboundMessages =
    (await claimedMessagesResponse.json()) as SmolpawsOutboundMessage[];

  const eventsResponse = await fetchImpl(
    `${agentServerBaseUrl}/api/conversations/${encodeURIComponent(data.id)}/events/search?kind=MessageEvent&source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      headers: env.SMOLPAWS_RUNNER_TOKEN
        ? { Authorization: `Bearer ${env.SMOLPAWS_RUNNER_TOKEN}` }
        : {},
    },
  );
  if (!eventsResponse.ok) {
    const responseText = await eventsResponse.text();
    throw new Error(`Agent-server events search error: ${responseText}`);
  }
  const reply = extractAssistantReplyFromEventPage(await eventsResponse.json());
  return {
    reply: reply ?? (outboundMessages.length > 0 ? undefined : buildFallbackReply(message)),
    outbound_messages:
      outboundMessages.length > 0
        ? collapseOutboundMessages(outboundMessages)
        : undefined,
  };
}
