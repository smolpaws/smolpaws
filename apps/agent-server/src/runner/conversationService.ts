import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  FileStore,
  type Event,
  type LocalConversation,
  type OpenHandsSettings,
  type SecretRegistry,
} from '@smolpaws/agent-sdk';
import {
  SmolpawsConversationConfigSchema,
} from '../shared/runner.js';
import type {
  SmolpawsConversationConfigValue,
} from '../shared/runner.js';

export type ConversationInfo = {
  id: string;
  created_at: string;
  updated_at: string;
  execution_status: string;
  title?: string;
};

export type ConversationPage = {
  items: ConversationInfo[];
  next_page_id?: string;
};

export type PersistedConversationMeta = {
  title?: string;
  smolpaws?: SmolpawsConversationConfigValue;
};

const PersistedConversationMetaSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    smolpaws: Type.Optional(SmolpawsConversationConfigSchema),
  },
  { additionalProperties: true },
);

export type ConversationRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  conversation: LocalConversation;
  events: Event[];
  settings: OpenHandsSettings;
  secrets: SecretRegistry;
  workspaceRoot: string;
  smolpaws?: SmolpawsConversationConfigValue;
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

function compareIsoDateStrings(left: string, right: string): number {
  return new Date(left).getTime() - new Date(right).getTime();
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

function normalizeExecutionStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isSafeConversationId(id: string): boolean {
  return !/[\\/]/.test(id) && !id.includes('\0');
}

export function resolvePersistenceRoot(
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  if (path.isAbsolute(persistenceDir)) {
    return persistenceDir;
  }
  return path.join(record?.workspaceRoot ?? process.cwd(), persistenceDir);
}

export function buildEventsFilePath(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir, record),
    'events.jsonl',
  );
}

export function buildStateFilePath(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir, record),
    'state.json',
  );
}

export function buildBaseStateFilePath(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir, record),
    'base_state.json',
  );
}

export function buildMetaFilePath(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir, record),
    'meta.json',
  );
}

export function buildConversationDirPath(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): string {
  return path.join(
    resolvePersistenceRoot(persistenceDir, record),
    conversationId,
  );
}

export function buildConversationInfo(
  record: ConversationRecord,
  deriveExecutionStatusFromEvents: (events: Event[]) => string,
): ConversationInfo {
  return {
    id: record.id,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    execution_status: deriveExecutionStatusFromEvents(record.events),
    ...(record.title ? { title: record.title } : {}),
  };
}

export async function buildConversationInfoFromPersistence(
  conversationId: string,
  persistenceDir: string,
  deriveExecutionStatusFromEvents: (events: Event[]) => string,
  record?: ConversationRecord,
): Promise<ConversationInfo> {
  if (record) {
    return buildConversationInfo(record, deriveExecutionStatusFromEvents);
  }
  const eventsPath = buildEventsFilePath(conversationId, persistenceDir, record);
  const statePath = buildStateFilePath(conversationId, persistenceDir, record);
  const baseStatePath = buildBaseStateFilePath(
    conversationId,
    persistenceDir,
    record,
  );
  const metaPath = buildMetaFilePath(conversationId, persistenceDir, record);
  let createdAt = new Date().toISOString();
  let updatedAt = createdAt;
  let executionStatus = 'idle';
  let title: string | undefined;

  for (const candidatePath of [eventsPath, statePath, baseStatePath, metaPath]) {
    try {
      const stats = await fs.stat(candidatePath);
      const created = (stats.birthtime ?? stats.ctime).toISOString();
      const modified = stats.mtime.toISOString();
      if (created < createdAt) {
        createdAt = created;
      }
      if (modified > updatedAt) {
        updatedAt = modified;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  for (const candidatePath of [statePath, baseStatePath]) {
    try {
      const rawState = await fs.readFile(candidatePath, 'utf8');
      const parsed = JSON.parse(rawState) as
        | { status?: unknown; execution_status?: unknown }
        | null;
      const rawStatus =
        typeof parsed?.status === 'string'
          ? parsed.status
          : typeof parsed?.execution_status === 'string'
            ? parsed.execution_status
            : undefined;
      if (rawStatus?.trim()) {
        executionStatus = rawStatus.trim().toLowerCase();
        break;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  try {
    const meta = await readPersistedConversationMeta(
      conversationId,
      persistenceDir,
      record,
    );
    if (typeof meta.title === 'string' && meta.title.trim()) {
      title = meta.title.trim();
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }

  return {
    id: conversationId,
    created_at: createdAt,
    updated_at: updatedAt,
    execution_status: executionStatus,
    ...(title ? { title } : {}),
  };
}

export async function readPersistedConversationMeta(
  conversationId: string,
  persistenceDir: string,
  record?: ConversationRecord,
): Promise<PersistedConversationMeta> {
  const metaPath = buildMetaFilePath(conversationId, persistenceDir, record);
  const rawMeta = await fs.readFile(metaPath, 'utf8');
  const parsed = JSON.parse(rawMeta) as unknown;
  if (!Value.Check(PersistedConversationMetaSchema, parsed)) {
    return {};
  }
  return parsed;
}

export async function listConversationInfos(
  persistenceDir: string,
  conversations: Map<string, ConversationRecord>,
  deriveExecutionStatusFromEvents: (events: Event[]) => string,
): Promise<ConversationInfo[]> {
  const rootDir = resolvePersistenceRoot(persistenceDir);
  const ids = new Set<string>(conversations.keys());
  for (const id of FileStore.listConversations(rootDir)) {
    ids.add(id);
  }
  const items = await Promise.all(
    Array.from(ids)
      .filter((id) => isSafeConversationId(id))
      .map(async (id) =>
        buildConversationInfoFromPersistence(
          id,
          persistenceDir,
          deriveExecutionStatusFromEvents,
          conversations.get(id),
        ),
      ),
  );
  items.sort(
    (left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
  );
  return items;
}

export async function writeConversationMeta(
  conversationId: string,
  persistenceDir: string,
  meta: PersistedConversationMeta,
  record?: ConversationRecord,
): Promise<void> {
  const metaPath = buildMetaFilePath(conversationId, persistenceDir, record);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

export function toTrimmedStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => toTrimmedStringArray(item))
      .filter((item) => item.length > 0);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function filterConversationInfos(
  items: ConversationInfo[],
  filters: { status?: unknown },
): ConversationInfo[] {
  const status = normalizeExecutionStatus(filters.status);
  if (!status) {
    return items;
  }
  return items.filter(
    (item) => normalizeExecutionStatus(item.execution_status) === status,
  );
}

export function sortConversationInfos(
  items: ConversationInfo[],
  sortOrder: string | undefined,
): ConversationInfo[] {
  const sorted = [...items];
  switch (sortOrder) {
    case 'CREATED_AT':
      sorted.sort(
        (left, right) => compareIsoDateStrings(left.created_at, right.created_at),
      );
      break;
    case 'UPDATED_AT':
      sorted.sort(
        (left, right) => compareIsoDateStrings(left.updated_at, right.updated_at),
      );
      break;
    case 'UPDATED_AT_DESC':
      sorted.sort(
        (left, right) => compareIsoDateStrings(right.updated_at, left.updated_at),
      );
      break;
    case 'CREATED_AT_DESC':
    default:
      sorted.sort(
        (left, right) => compareIsoDateStrings(right.created_at, left.created_at),
      );
      break;
  }
  return sorted;
}

export function paginateConversationInfos(
  items: ConversationInfo[],
  params: { pageId?: unknown; limit?: unknown },
): ConversationPage {
  const limit = parsePaginationLimit(params.limit);
  const offset = resolvePageStartIndex(items, params.pageId, (item) => item.id);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    next_page_id: nextOffset < items.length ? items[nextOffset]?.id : undefined,
  };
}

export function hasPersistedConversation(
  conversationId: string,
  persistenceDir: string,
): boolean {
  if (!isSafeConversationId(conversationId)) {
    return false;
  }
  const rootDir = resolvePersistenceRoot(persistenceDir);
  return FileStore.listConversations(rootDir).includes(conversationId);
}

export function getLiveConversationOrThrow(
  conversationId: string,
  persistenceDir: string,
  conversations: Map<string, ConversationRecord>,
): ConversationRecord {
  const record = conversations.get(conversationId);
  if (record) {
    return record;
  }
  if (hasPersistedConversation(conversationId, persistenceDir)) {
    throw new Error('conversation_not_live');
  }
  throw new Error('conversation_not_found');
}

export async function getConversationInfoOrThrow(
  conversationId: string,
  persistenceDir: string,
  conversations: Map<string, ConversationRecord>,
  deriveExecutionStatusFromEvents: (events: Event[]) => string,
): Promise<ConversationInfo> {
  if (!isSafeConversationId(conversationId)) {
    throw new Error('invalid_conversation_id');
  }
  if (
    !hasPersistedConversation(conversationId, persistenceDir) &&
    !conversations.has(conversationId)
  ) {
    throw new Error('conversation_not_found');
  }
  return buildConversationInfoFromPersistence(
    conversationId,
    persistenceDir,
    deriveExecutionStatusFromEvents,
    conversations.get(conversationId),
  );
}
