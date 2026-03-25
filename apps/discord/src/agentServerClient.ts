import type { Logger } from 'pino';

export type SmolpawsOutboundMessage = {
  kind: 'current_thread_message';
  text: string;
};

type ConversationResponse = {
  id: string;
  execution_status?: string;
};

type EventPage = {
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

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const TERMINAL_STATUSES = new Set(['idle', 'finished', 'error', 'stuck', 'paused']);

type WaitForCompletionOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: typeof sleep;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function extractAssistantReply(page: EventPage): string | null {
  for (const item of page.items) {
    if (item.kind !== 'MessageEvent' || item.llm_message?.role !== 'assistant') {
      continue;
    }
    const text = (item.llm_message.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => (part.text as string).trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCompletion(
  baseUrl: string,
  conversationId: string,
  token: string | undefined,
  logger: Logger,
  options: WaitForCompletionOptions = {},
): Promise<void> {
  const {
    fetchImpl = fetch,
    sleepImpl = sleep,
    pollIntervalMs = POLL_INTERVAL_MS,
    pollTimeoutMs = POLL_TIMEOUT_MS,
  } = options;
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);

    try {
      const res = await fetchImpl(
        `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
        { headers: buildHeaders(token) },
      );
      if (!res.ok) {
        logger.warn({ status: res.status, conversationId }, 'Failed to poll conversation status');
        continue;
      }

      const data = (await res.json()) as ConversationResponse;
      const status = data.execution_status ?? 'unknown';
      logger.debug({ conversationId, execution_status: status }, 'Polling conversation');

      if (TERMINAL_STATUSES.has(status)) {
        return;
      }
    } catch (error) {
      logger.warn({ err: error, conversationId }, 'Failed to poll conversation status');
    }
  }

  logger.warn({ conversationId }, 'Timed out waiting for agent to finish');
}

export type DispatchResult = {
  reply?: string;
  outboundMessages: SmolpawsOutboundMessage[];
  conversationId: string;
};

export async function dispatchToAgentServer(options: {
  baseUrl: string;
  token?: string;
  conversationId: string;
  prompt: string;
  discord: {
    guild_id?: string;
    channel_id: string;
    author_id: string;
    author_name: string;
  };
  logger: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: typeof sleep;
}): Promise<DispatchResult> {
  const {
    baseUrl,
    token,
    conversationId,
    prompt,
    discord,
    logger,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = options;

  // Try to create or continue conversation
  const convResponse = await fetchImpl(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildHeaders(token),
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
        ingress: 'discord',
        enable_send_message: true,
        discord,
      },
    }),
  });

  if (!convResponse.ok) {
    const text = await convResponse.text();
    throw new Error(`Agent-server error (${convResponse.status}): ${text}`);
  }

  const isNewConversation = convResponse.status === 201;
  const convData = (await convResponse.json()) as ConversationResponse;
  if (!convData.id) {
    throw new Error('Agent-server response missing conversation id');
  }

  // If the conversation already existed, the agent-server returns 200 and
  // silently ignores the initial_message. Send it explicitly via the events
  // endpoint and trigger a run.
  if (!isNewConversation) {
    logger.debug({ conversationId: convData.id }, 'Conversation already exists; sending message via events endpoint');

    const msgResponse = await fetchImpl(
      `${baseUrl}/api/conversations/${encodeURIComponent(convData.id)}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(token),
        },
        body: JSON.stringify({
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          run: true,
        }),
      },
    );

    if (!msgResponse.ok) {
      const text = await msgResponse.text();
      throw new Error(`Failed to send message to existing conversation (${msgResponse.status}): ${text}`);
    }
  }

  logger.debug(
    { conversationId: convData.id, isNew: isNewConversation },
    'Conversation dispatched',
  );

  // Wait for the agent to finish processing
  await waitForCompletion(baseUrl, convData.id, token, logger, {
    fetchImpl,
    sleepImpl,
  });

  // Claim outbound messages
  const outboundResponse = await fetchImpl(
    `${baseUrl}/api/conversations/${encodeURIComponent(convData.id)}/outbound_messages/claim`,
    {
      method: 'POST',
      headers: buildHeaders(token),
    },
  );

  let outboundMessages: SmolpawsOutboundMessage[] = [];
  if (outboundResponse.ok) {
    outboundMessages = (await outboundResponse.json()) as SmolpawsOutboundMessage[];
  }

  if (outboundMessages.length > 0) {
    return { outboundMessages, conversationId: convData.id };
  }

  // Fall back to reading the last assistant message from events
  const eventsResponse = await fetchImpl(
    `${baseUrl}/api/conversations/${encodeURIComponent(convData.id)}/events/search?kind=MessageEvent&source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
    {
      headers: buildHeaders(token),
    },
  );

  let reply: string | undefined;
  if (eventsResponse.ok) {
    const page = (await eventsResponse.json()) as EventPage;
    reply = extractAssistantReply(page) ?? undefined;
  }

  return {
    reply,
    outboundMessages,
    conversationId: convData.id,
  };
}
