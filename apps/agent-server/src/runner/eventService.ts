import fs from 'node:fs/promises';
import type { Event } from '@smolpaws/agent-sdk';
import {
  buildEventsFilePath,
  isSafeConversationId,
  type ConversationRecord,
} from './conversationService.js';

export type EventPage = {
  items: Event[];
  next_page_id?: string;
};

function parsePaginationLimit(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.min(100, Math.trunc(raw));
  }
  return 100;
}

function parsePageOffset(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw);
  }
  return 0;
}

function resolvePageStartIndex<T>(
  items: T[],
  pageId: unknown,
  getId: (item: T) => string,
): number {
  const normalized = typeof pageId === 'string' ? pageId.trim() : '';
  if (!normalized) {
    return 0;
  }
  if (/^\d+$/.test(normalized)) {
    return parsePageOffset(normalized);
  }
  const index = items.findIndex((item) => getId(item) === normalized);
  return index >= 0 ? index : 0;
}

export async function readPersistedEventsOrThrow(
  conversationId: string,
  persistenceDir: string,
): Promise<Event[]> {
  if (!isSafeConversationId(conversationId)) {
    throw new Error('invalid_conversation_id');
  }
  const eventsPath = buildEventsFilePath(conversationId, persistenceDir);
  try {
    const content = await fs.readFile(eventsPath, 'utf8');
    const events: Event[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as Event);
      } catch (error) {
        console.error(`Skipping corrupted persisted event: ${String(error)}`);
      }
    }
    return events;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error('conversation_not_found');
    }
    throw error;
  }
}

export function paginateEvents(
  events: Event[],
  params: { pageId?: unknown; limit?: unknown },
): EventPage {
  const limit = parsePaginationLimit(params.limit);
  const safeOffset = resolvePageStartIndex(
    events,
    params.pageId,
    (event) =>
      typeof (event as { id?: unknown }).id === 'string'
        ? (event as { id: string }).id
        : '',
  );
  const items = events.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + items.length;
  return {
    items,
    next_page_id:
      nextOffset < events.length
        ? typeof (events[nextOffset] as { id?: unknown }).id === 'string'
          ? (events[nextOffset] as { id: string }).id
          : undefined
        : undefined,
  };
}

export async function getConversationEventsOrThrow(
  conversationId: string,
  persistenceDir: string,
  conversations: Map<string, ConversationRecord>,
): Promise<Event[]> {
  const record = conversations.get(conversationId);
  if (record) {
    return record.events;
  }
  return await readPersistedEventsOrThrow(conversationId, persistenceDir);
}
