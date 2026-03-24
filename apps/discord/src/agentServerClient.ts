import type { Logger } from 'pino';

export type SmolpawsOutboundMessage = {
  kind: 'current_thread_message';
  text: string;
};

type ConversationResponse = {
  id: string;
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
}): Promise<DispatchResult> {
  const { baseUrl, token, conversationId, prompt, discord, logger } = options;

  // Create or continue conversation
  const convResponse = await fetch(`${baseUrl}/api/conversations`, {
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

  const convData = (await convResponse.json()) as ConversationResponse;
  if (!convData.id) {
    throw new Error('Agent-server response missing conversation id');
  }

  logger.debug({ conversationId: convData.id }, 'Conversation created/continued');

  // Claim outbound messages
  const outboundResponse = await fetch(
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
  const eventsResponse = await fetch(
    `${baseUrl}/api/conversations/${encodeURIComponent(convData.id)}/events/search?source=agent&sort_order=TIMESTAMP_DESC&limit=20`,
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
