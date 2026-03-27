import type {
  SmolpawsOutboundMessage,
  SmolpawsTaskCommand,
} from './runner.js';

export type TurnTerminalStatus =
  | 'completed'
  | 'waiting_for_confirmation'
  | 'paused'
  | 'error'
  | 'stuck';

export type TurnStatus = 'running' | TurnTerminalStatus;

export type ConversationMessagePayload = {
  role: 'user';
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  extended_content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  run?: boolean;
};

export type SubmitConversationMessageResult = {
  conversation_id: string;
  turn_id: string;
  message_event_id: string;
  started_new_turn: boolean;
  status: TurnStatus;
  is_delivery_owner: boolean;
};

export type TurnInfo = {
  conversation_id: string;
  turn_id: string;
  status: TurnStatus;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  is_delivery_owner: boolean;
};

export type TurnResult = {
  conversation_id: string;
  turn_id: string;
  status: TurnStatus;
  reply?: string;
  error_code?: string;
  error_detail?: string;
};

export type MonitorTurnResult = {
  conversationId: string;
  turnId: string;
  status: TurnStatus;
  reply?: string;
  deliveredOutboundCount: number;
  isDeliveryOwner: boolean;
};

type FetchLike = typeof fetch;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINAL_TURN_STATUSES = new Set<TurnTerminalStatus>([
  'completed',
  'waiting_for_confirmation',
  'paused',
  'error',
  'stuck',
]);

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Agent-server base URL is required');
  }
  if (normalized.endsWith('/run')) {
    throw new Error(
      'Agent-server base URL must not end with /run',
    );
  }
  return normalized;
}

function buildHeaders(
  authToken?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(extraHeaders ?? {}),
  };
}

function buildUrl(pathname: string, baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}${pathname}`;
}

function createFallbackId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDeliveryOwnerId(): string {
  return globalThis.crypto?.randomUUID?.() ?? createFallbackId();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Agent-server error (${response.status}): ${await response.text()}`);
  }
  return await response.json() as T;
}

export async function submitConversationMessage(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  userMessage: ConversationMessagePayload;
  idempotencyKey: string;
  createConversation?: unknown;
  deliveryOwnerId?: string;
  fetchImpl?: FetchLike;
}): Promise<SubmitConversationMessageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(
      `/api/conversations/${encodeURIComponent(options.conversationId)}/turns`,
      options.baseUrl,
    ),
    {
      method: 'POST',
      headers: buildHeaders(options.authToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        user_message: options.userMessage,
        idempotency_key: options.idempotencyKey,
        ...(options.createConversation
          ? { create_conversation: options.createConversation }
          : {}),
        ...(options.deliveryOwnerId
          ? { delivery_owner_id: options.deliveryOwnerId }
          : {}),
      }),
    },
  );
  return await parseJsonResponse<SubmitConversationMessageResult>(response);
}

export async function getTurnStatus(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  deliveryOwnerId?: string;
  fetchImpl?: FetchLike;
}): Promise<TurnInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (options.deliveryOwnerId) {
    params.set('delivery_owner_id', options.deliveryOwnerId);
  }
  const response = await fetchImpl(
    buildUrl(
      `/api/conversations/${encodeURIComponent(options.conversationId)}/turns/${encodeURIComponent(options.turnId)}${params.size ? `?${params}` : ''}`,
      options.baseUrl,
    ),
    {
      headers: buildHeaders(options.authToken),
    },
  );
  return await parseJsonResponse<TurnInfo>(response);
}

export async function claimTurnOutboundMessages(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  deliveryOwnerId: string;
  fetchImpl?: FetchLike;
}): Promise<SmolpawsOutboundMessage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(
      `/api/conversations/${encodeURIComponent(options.conversationId)}/turns/${encodeURIComponent(options.turnId)}/outbound_messages/claim`,
      options.baseUrl,
    ),
    {
      method: 'POST',
      headers: buildHeaders(options.authToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ delivery_owner_id: options.deliveryOwnerId }),
    },
  );
  return await parseJsonResponse<SmolpawsOutboundMessage[]>(response);
}

export async function claimTurnTaskCommands(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  deliveryOwnerId: string;
  fetchImpl?: FetchLike;
}): Promise<SmolpawsTaskCommand[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(
      `/api/conversations/${encodeURIComponent(options.conversationId)}/turns/${encodeURIComponent(options.turnId)}/task_commands/claim`,
      options.baseUrl,
    ),
    {
      method: 'POST',
      headers: buildHeaders(options.authToken, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ delivery_owner_id: options.deliveryOwnerId }),
    },
  );
  return await parseJsonResponse<SmolpawsTaskCommand[]>(response);
}

export async function getTurnResult(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  fetchImpl?: FetchLike;
}): Promise<TurnResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(
      `/api/conversations/${encodeURIComponent(options.conversationId)}/turns/${encodeURIComponent(options.turnId)}/result`,
      options.baseUrl,
    ),
    {
      headers: buildHeaders(options.authToken),
    },
  );
  return await parseJsonResponse<TurnResult>(response);
}

export async function monitorTurn(options: {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  deliveryOwnerId: string;
  isDeliveryOwner: boolean;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOutboundMessage?: (message: SmolpawsOutboundMessage) => Promise<void> | void;
}): Promise<MonitorTurnResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  if (!options.isDeliveryOwner) {
    const status = await getTurnStatus({
      baseUrl: options.baseUrl,
      authToken: options.authToken,
      conversationId: options.conversationId,
      turnId: options.turnId,
      deliveryOwnerId: options.deliveryOwnerId,
      fetchImpl,
    });
    return {
      conversationId: options.conversationId,
      turnId: options.turnId,
      status: status.status,
      deliveredOutboundCount: 0,
      isDeliveryOwner: false,
    };
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let deliveredOutboundCount = 0;

  while (Date.now() < deadline) {
    const status = await getTurnStatus({
      baseUrl: options.baseUrl,
      authToken: options.authToken,
      conversationId: options.conversationId,
      turnId: options.turnId,
      deliveryOwnerId: options.deliveryOwnerId,
      fetchImpl,
    });

    const outboundMessages = await claimTurnOutboundMessages({
      baseUrl: options.baseUrl,
      authToken: options.authToken,
      conversationId: options.conversationId,
      turnId: options.turnId,
      deliveryOwnerId: options.deliveryOwnerId,
      fetchImpl,
    });
    for (const outboundMessage of outboundMessages) {
      await options.onOutboundMessage?.(outboundMessage);
      deliveredOutboundCount += 1;
    }

    if (TERMINAL_TURN_STATUSES.has(status.status as TurnTerminalStatus)) {
      const result = await getTurnResult({
        baseUrl: options.baseUrl,
        authToken: options.authToken,
        conversationId: options.conversationId,
        turnId: options.turnId,
        fetchImpl,
      });
      return {
        conversationId: options.conversationId,
        turnId: options.turnId,
        status: result.status as TurnTerminalStatus,
        ...(result.reply ? { reply: result.reply } : {}),
        deliveredOutboundCount,
        isDeliveryOwner: true,
      };
    }

    await sleepImpl(pollIntervalMs);
  }

  return {
    conversationId: options.conversationId,
    turnId: options.turnId,
    status: 'stuck',
    deliveredOutboundCount,
    isDeliveryOwner: true,
  };
}
