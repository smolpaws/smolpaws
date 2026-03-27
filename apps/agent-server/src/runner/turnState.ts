import fs from 'node:fs/promises';
import path from 'node:path';
import type { TextContent } from '@smolpaws/agent-sdk';
import { buildConversationDirPath } from './conversationService.js';

export type ConversationTurnTerminalStatus =
  | 'completed'
  | 'waiting_for_confirmation'
  | 'paused'
  | 'error'
  | 'stuck';

export type ConversationTurnStatus =
  | 'running'
  | ConversationTurnTerminalStatus;

export type ConversationTurnMessage = {
  id: string;
  idempotency_key: string;
  accepted_at: string;
  content: TextContent[];
  extended_content?: TextContent[];
  event_id?: string;
};

export type ConversationTurn = {
  id: string;
  sequence: number;
  status: ConversationTurnStatus;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  start_event_id?: string;
  end_event_id?: string;
  final_reply_event_id?: string;
  error_code?: string;
  error_detail?: string;
  delivery_owner_id?: string;
  delivery_owner_claimed_at?: string;
  messages: ConversationTurnMessage[];
};

export type ConversationTurnState = {
  next_sequence: number;
  turns: ConversationTurn[];
};

const DEFAULT_TURN_STATE: ConversationTurnState = {
  next_sequence: 1,
  turns: [],
};

function normalizeTextContentArray(value: unknown): TextContent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is TextContent =>
      Boolean(item) &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string',
  );
}

function normalizeTurnMessage(value: unknown): ConversationTurnMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const idempotencyKey =
    typeof record.idempotency_key === 'string'
      ? record.idempotency_key.trim()
      : '';
  const acceptedAt =
    typeof record.accepted_at === 'string' ? record.accepted_at : '';
  const content = normalizeTextContentArray(record.content);
  if (!id || !idempotencyKey || !acceptedAt || content.length === 0) {
    return null;
  }
  const extendedContent = normalizeTextContentArray(record.extended_content);
  return {
    id,
    idempotency_key: idempotencyKey,
    accepted_at: acceptedAt,
    content,
    ...(extendedContent.length ? { extended_content: extendedContent } : {}),
    ...(typeof record.event_id === 'string' && record.event_id.trim()
      ? { event_id: record.event_id.trim() }
      : {}),
  };
}

function normalizeTurn(value: unknown): ConversationTurn | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const sequence =
    typeof record.sequence === 'number' && Number.isFinite(record.sequence)
      ? Math.max(1, Math.trunc(record.sequence))
      : 0;
  const status =
    typeof record.status === 'string' ? record.status.trim() : '';
  const startedAt =
    typeof record.started_at === 'string' ? record.started_at : '';
  const updatedAt =
    typeof record.updated_at === 'string' ? record.updated_at : '';
  const messages = Array.isArray(record.messages)
    ? record.messages
        .map((message) => normalizeTurnMessage(message))
        .filter((message): message is ConversationTurnMessage => Boolean(message))
    : [];
  if (
    !id ||
    !sequence ||
    !startedAt ||
    !updatedAt ||
    !(
      status === 'running' ||
      status === 'completed' ||
      status === 'waiting_for_confirmation' ||
      status === 'paused' ||
      status === 'error' ||
      status === 'stuck'
    )
  ) {
    return null;
  }
  return {
    id,
    sequence,
    status,
    started_at: startedAt,
    updated_at: updatedAt,
    ...(typeof record.completed_at === 'string'
      ? { completed_at: record.completed_at }
      : {}),
    ...(typeof record.start_event_id === 'string' && record.start_event_id.trim()
      ? { start_event_id: record.start_event_id.trim() }
      : {}),
    ...(typeof record.end_event_id === 'string' && record.end_event_id.trim()
      ? { end_event_id: record.end_event_id.trim() }
      : {}),
    ...(typeof record.final_reply_event_id === 'string' &&
    record.final_reply_event_id.trim()
      ? { final_reply_event_id: record.final_reply_event_id.trim() }
      : {}),
    ...(typeof record.error_code === 'string' && record.error_code.trim()
      ? { error_code: record.error_code.trim() }
      : {}),
    ...(typeof record.error_detail === 'string' && record.error_detail.trim()
      ? { error_detail: record.error_detail.trim() }
      : {}),
    ...(typeof record.delivery_owner_id === 'string' &&
    record.delivery_owner_id.trim()
      ? { delivery_owner_id: record.delivery_owner_id.trim() }
      : {}),
    ...(typeof record.delivery_owner_claimed_at === 'string'
      ? { delivery_owner_claimed_at: record.delivery_owner_claimed_at }
      : {}),
    messages,
  };
}

function normalizeTurnState(value: unknown): ConversationTurnState {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_TURN_STATE };
  }
  const record = value as Record<string, unknown>;
  const turns = Array.isArray(record.turns)
    ? record.turns
        .map((turn) => normalizeTurn(turn))
        .filter((turn): turn is ConversationTurn => Boolean(turn))
        .sort((left, right) => left.sequence - right.sequence)
    : [];
  const nextSequence =
    typeof record.next_sequence === 'number' &&
    Number.isFinite(record.next_sequence)
      ? Math.max(
          1,
          Math.trunc(record.next_sequence),
          turns.reduce((max, turn) => Math.max(max, turn.sequence + 1), 1),
        )
      : turns.reduce((max, turn) => Math.max(max, turn.sequence + 1), 1);
  return {
    next_sequence: nextSequence,
    turns,
  };
}

export function buildTurnsFilePath(
  conversationId: string,
  persistenceDir: string,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir),
    'turns.json',
  );
}

export async function readPersistedTurnState(
  conversationId: string,
  persistenceDir: string,
): Promise<ConversationTurnState> {
  const filePath = buildTurnsFilePath(conversationId, persistenceDir);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeTurnState(JSON.parse(raw) as unknown);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { ...DEFAULT_TURN_STATE };
    }
    throw error;
  }
}

export async function writePersistedTurnState(
  conversationId: string,
  persistenceDir: string,
  turnState: ConversationTurnState,
): Promise<void> {
  const filePath = buildTurnsFilePath(conversationId, persistenceDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(turnState, null, 2), 'utf8');
}

export function isTurnTerminalStatus(
  status: ConversationTurnStatus,
): status is ConversationTurnTerminalStatus {
  return status !== 'running';
}

export function getLatestTurn(
  turnState: ConversationTurnState,
): ConversationTurn | undefined {
  return turnState.turns[turnState.turns.length - 1];
}

export function getTurnById(
  turnState: ConversationTurnState,
  turnId: string,
): ConversationTurn | undefined {
  return turnState.turns.find((turn) => turn.id === turnId);
}

export function getActiveTurn(
  turnState: ConversationTurnState,
): ConversationTurn | undefined {
  const latestTurn = getLatestTurn(turnState);
  if (!latestTurn || isTurnTerminalStatus(latestTurn.status)) {
    return undefined;
  }
  return latestTurn;
}

export function findMessageByIdempotencyKey(
  turnState: ConversationTurnState,
  idempotencyKey: string,
): { turn: ConversationTurn; message: ConversationTurnMessage } | undefined {
  for (const turn of turnState.turns) {
    const message = turn.messages.find(
      (candidate) => candidate.idempotency_key === idempotencyKey,
    );
    if (message) {
      return { turn, message };
    }
  }
  return undefined;
}

export function createRunningTurn(
  turnState: ConversationTurnState,
  now: string,
  deliveryOwnerId?: string,
): ConversationTurn {
  const turn: ConversationTurn = {
    id: `turn-${turnState.next_sequence}-${Math.random().toString(36).slice(2, 8)}`,
    sequence: turnState.next_sequence,
    status: 'running',
    started_at: now,
    updated_at: now,
    ...(deliveryOwnerId
      ? {
          delivery_owner_id: deliveryOwnerId,
          delivery_owner_claimed_at: now,
        }
      : {}),
    messages: [],
  };
  turnState.next_sequence += 1;
  turnState.turns.push(turn);
  return turn;
}

export function appendAcceptedTurnMessage(
  turn: ConversationTurn,
  message: ConversationTurnMessage,
): void {
  turn.messages.push(message);
  turn.updated_at = message.accepted_at;
}

export function updateTurnStatus(
  turn: ConversationTurn,
  status: ConversationTurnStatus,
  now: string,
  options?: {
    endEventId?: string;
    finalReplyEventId?: string;
    errorCode?: string;
    errorDetail?: string;
  },
): void {
  turn.status = status;
  turn.updated_at = now;
  if (isTurnTerminalStatus(status)) {
    turn.completed_at = now;
  }
  if (options?.endEventId) {
    turn.end_event_id = options.endEventId;
  }
  if (options?.finalReplyEventId) {
    turn.final_reply_event_id = options.finalReplyEventId;
  }
  if (options?.errorCode) {
    turn.error_code = options.errorCode;
  }
  if (options?.errorDetail) {
    turn.error_detail = options.errorDetail;
  }
}

export function assignDeliveryOwner(
  turn: ConversationTurn,
  ownerId: string | undefined,
  now: string,
): boolean {
  if (!ownerId) {
    return false;
  }
  if (!turn.delivery_owner_id || turn.delivery_owner_id === ownerId) {
    turn.delivery_owner_id = ownerId;
    turn.delivery_owner_claimed_at = now;
    turn.updated_at = now;
    return true;
  }
  return false;
}
