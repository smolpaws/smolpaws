import {
  isConversationStateUpdateEvent,
  isMessageEvent,
  reduceTextContent,
  type Event,
  type MessageEvent,
} from '@smolpaws/agent-sdk';
import { extractExtendedContentText } from "./messageText.js";

type PageIdParams = { pageId?: unknown; limit?: unknown };

const DEFAULT_PAGE_LIMIT = 100;

function parsePaginationLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(DEFAULT_PAGE_LIMIT, Math.trunc(limit)));
}

function resolvePageStartIndex<T>(
  items: T[],
  pageId: unknown,
  getId: (item: T) => string,
): number {
  if (typeof pageId !== 'string' || !pageId.trim()) {
    return 0;
  }
  const index = items.findIndex((item) => getId(item) === pageId);
  return index >= 0 ? index : 0;
}

export function paginateItems<T extends { id: string }>(
  items: T[],
  params: PageIdParams,
): { items: T[]; next_page_id?: string } {
  const limit = parsePaginationLimit(params.limit);
  const offset = resolvePageStartIndex(items, params.pageId, (item) => item.id);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    next_page_id: nextOffset < items.length ? items[nextOffset]?.id : undefined,
  };
}

function parseOptionalDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getEventTimestamp(event: Event): number {
  const value = Date.parse(String((event as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isNaN(value) ? 0 : value;
}

function getEventBodyText(event: Event): string {
  if (isMessageEvent(event)) {
    const parts = [reduceTextContent(event.llm_message).trim()];
    const extendedContent = (event as { extended_content?: unknown })
      .extended_content;
    const text = extractExtendedContentText(extendedContent);
    if (text) {
      parts.push(text);
    }
    const reasoning = (event as { reasoning_content?: unknown }).reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      parts.push(reasoning.trim());
    }
    return parts.join('\n').trim();
  }
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail === 'string') {
    return detail;
  }
  return JSON.stringify(event);
}

export function filterEvents(
  events: Event[],
  filters: {
    kind?: unknown;
    source?: unknown;
    body?: unknown;
    timestampGte?: unknown;
    timestampLt?: unknown;
    sortOrder?: unknown;
  },
): Event[] {
  const kind = typeof filters.kind === 'string' ? filters.kind.trim() : '';
  const source = typeof filters.source === 'string' ? filters.source.trim() : '';
  const body = typeof filters.body === 'string' ? filters.body.trim().toLowerCase() : '';
  const timestampGte = parseOptionalDate(filters.timestampGte);
  const timestampLt = parseOptionalDate(filters.timestampLt);

  const filtered = events.filter((event) => {
    if (
      kind &&
      event.kind !== kind &&
      !kind.endsWith(`.${event.kind}`)
    ) {
      return false;
    }
    const eventSource = (event as { source?: unknown }).source;
    if (source && eventSource !== source) {
      return false;
    }
    if (body && !getEventBodyText(event).toLowerCase().includes(body)) {
      return false;
    }
    const timestamp = getEventTimestamp(event);
    if (timestampGte !== undefined && timestamp < timestampGte) {
      return false;
    }
    if (timestampLt !== undefined && timestamp >= timestampLt) {
      return false;
    }
    return true;
  });

  if (filters.sortOrder === 'TIMESTAMP_DESC') {
    filtered.sort((left, right) => getEventTimestamp(right) - getEventTimestamp(left));
    return filtered;
  }
  filtered.sort((left, right) => getEventTimestamp(left) - getEventTimestamp(right));
  return filtered;
}

export function generateTitleFromEvents(
  events: Event[],
  maxLength: number,
): string {
  const userMessages = events.filter(
    (event): event is MessageEvent =>
      isMessageEvent(event) && event.llm_message.role === 'user',
  );

  const base = userMessages
    .map((event) => reduceTextContent(event.llm_message).trim())
    .find((text) => text.length > 0);

  const fallback = base ?? 'Conversation';
  return fallback.slice(0, Math.max(1, maxLength)).trim();
}

export function deriveExecutionStatusFromEvents(events: Event[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isConversationStateUpdateEvent(event)) {
      continue;
    }

    if (typeof event.agent_status === 'string' && event.agent_status.trim()) {
      return event.agent_status.trim().toLowerCase();
    }

    if (
      event.key === 'full_state'
    ) {
      const status = (
        event.value as { execution_status?: unknown } | null | undefined
      )?.execution_status;
      if (typeof status === 'string' && status.trim()) {
        return status.trim().toLowerCase();
      }
    }
  }

  return 'idle';
}

export function hasQueuedUserMessage(events: Event[]): boolean {
  const lastEvent = events[events.length - 1];
  return Boolean(lastEvent) && isMessageEvent(lastEvent) && lastEvent.source === 'user';
}
