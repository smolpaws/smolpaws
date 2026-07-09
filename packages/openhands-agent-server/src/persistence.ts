import fs from 'node:fs/promises';
import path from 'node:path';

import { eventSchema, startConversationRequestSchema, type Event, type StartConversationRequest, type StoredConversation } from './models.js';

const CONVERSATION_META_FILE = 'conversation.json';
const EVENTS_FILE = 'events.jsonl';

interface PersistedConversationFile {
  readonly id: string;
  readonly request: StartConversationRequest;
  readonly workspace?: unknown;
  readonly title?: string | null;
  readonly tags?: Record<string, string>;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface PersistedConversation {
  readonly stored: StoredConversation;
  readonly events: readonly Event[];
}

export function isSafeConversationId(id: string): boolean {
  return id.length > 0 && !id.includes('\0') && !id.includes('/') && !id.includes('\\');
}

export function resolvePersistenceRoot(persistenceDir: string | null | undefined, fallback: string): string {
  const raw = persistenceDir?.trim() || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

export function conversationDirectory(stored: StoredConversation, fallbackRoot: string): string {
  return path.join(resolvePersistenceRoot(stored.request.persistence_dir, fallbackRoot), stored.id);
}

export class ConversationPersistence {
  constructor(readonly defaultRoot: string) {}

  async loadAll(): Promise<PersistedConversation[]> {
    const root = resolvePersistenceRoot(this.defaultRoot, this.defaultRoot);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    });
    const loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isSafeConversationId(entry.name))
        .map(async (entry) => this.load(entry.name, root)),
    );
    return loaded.filter((item): item is PersistedConversation => item !== null);
  }

  async saveConversation(stored: StoredConversation): Promise<void> {
    const dir = conversationDirectory(stored, this.defaultRoot);
    await fs.mkdir(dir, { recursive: true });
    const payload: PersistedConversationFile = {
      id: stored.id,
      request: stored.request,
      workspace: stored.workspace,
      title: stored.title,
      tags: stored.tags,
      created_at: stored.created_at,
      updated_at: stored.updated_at,
    };
    await writeJsonAtomic(path.join(dir, CONVERSATION_META_FILE), payload);
  }

  async appendEvent(stored: StoredConversation, event: Event): Promise<void> {
    const dir = conversationDirectory(stored, this.defaultRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async replaceEvents(stored: StoredConversation, events: readonly Event[]): Promise<void> {
    const dir = conversationDirectory(stored, this.defaultRoot);
    await fs.mkdir(dir, { recursive: true });
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFileAtomic(path.join(dir, EVENTS_FILE), content.length > 0 ? `${content}\n` : '');
  }

  async deleteConversation(stored: StoredConversation): Promise<void> {
    await fs.rm(conversationDirectory(stored, this.defaultRoot), { recursive: true, force: true });
  }

  private async load(id: string, root: string): Promise<PersistedConversation | null> {
    const dir = path.join(root, id);
    const meta = await readJson(path.join(dir, CONVERSATION_META_FILE));
    const events = await readEvents(path.join(dir, EVENTS_FILE));
    if (meta === null && events.length === 0) return null;

    const now = new Date().toISOString();
    const parsedMeta = parseMeta(id, meta, this.defaultRoot, now);
    const stats = await statTimes([path.join(dir, CONVERSATION_META_FILE), path.join(dir, EVENTS_FILE)], now);
    return {
      stored: {
        ...parsedMeta,
        created_at: parsedMeta.created_at || stats.created_at,
        updated_at: parsedMeta.updated_at || stats.updated_at,
      },
      events,
    };
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readEvents(filePath: string): Promise<Event[]> {
  const content = await fs.readFile(filePath, 'utf8').catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return '';
    throw error;
  });
  const events: Event[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(eventSchema.parse(JSON.parse(trimmed)));
    } catch (error) {
      console.error('Skipping corrupted persisted event', error);
    }
  }
  return events;
}

function parseMeta(id: string, raw: unknown, defaultRoot: string, now: string): StoredConversation {
  const object = isRecord(raw) ? raw : {};
  const request = startConversationRequestSchema.parse({ id, persistence_dir: defaultRoot, ...asRecord(object.request) });
  return {
    id,
    request,
    workspace: request.workspace,
    title: typeof object.title === 'string' ? object.title : null,
    tags: isStringRecord(object.tags) ? object.tags : {},
    created_at: typeof object.created_at === 'string' ? object.created_at : now,
    updated_at: typeof object.updated_at === 'string' ? object.updated_at : now,
  };
}

async function statTimes(files: readonly string[], fallback: string): Promise<{ readonly created_at: string; readonly updated_at: string }> {
  let createdAt = fallback;
  let updatedAt = fallback;
  for (const file of files) {
    const stats = await fs.stat(file).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    });
    if (stats === null) continue;
    const created = stats.birthtime.toISOString();
    const updated = stats.mtime.toISOString();
    if (created < createdAt) createdAt = created;
    if (updated > updatedAt) updatedAt = updated;
  }
  return { created_at: createdAt, updated_at: updatedAt };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isErrno(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

