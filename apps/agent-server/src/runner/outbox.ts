import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SmolpawsOutboundMessage,
  SmolpawsTaskCommand,
} from '../shared/runner.js';
import { buildConversationDirPath } from './conversationService.js';

type QueueEnvelope<T> = {
  turn_id?: string;
  payload: T;
};

type ClaimQueueOptions = {
  turnId?: string;
  claimAll?: boolean;
};

const queueLocks = new Map<string, Promise<void>>();

function buildQueueFilePath(
  conversationId: string,
  persistenceDir: string,
  basename: string,
): string {
  return path.join(
    buildConversationDirPath(conversationId, persistenceDir),
    basename,
  );
}

function buildOutboxFilePath(
  conversationId: string,
  persistenceDir: string,
): string {
  return buildQueueFilePath(conversationId, persistenceDir, 'outbox.jsonl');
}

function buildTaskCommandFilePath(
  conversationId: string,
  persistenceDir: string,
): string {
  return buildQueueFilePath(conversationId, persistenceDir, 'task-commands.jsonl');
}

async function appendQueueItem<T>(
  filePath: string,
  item: QueueEnvelope<T>,
): Promise<void> {
  await withQueueLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(item)}\n`, 'utf8');
  });
}

async function withQueueLock<T>(
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  const prior = queueLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prior.then(() => current);
  queueLocks.set(filePath, chain);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (queueLocks.get(filePath) === chain) {
      queueLocks.delete(filePath);
    }
  }
}

function parseQueueEnvelope<T>(line: string): QueueEnvelope<T> {
  const parsed = JSON.parse(line) as QueueEnvelope<T> | T;
  if (
    parsed &&
    typeof parsed === 'object' &&
    'payload' in parsed
  ) {
    return parsed as QueueEnvelope<T>;
  }
  return { payload: parsed as T };
}

function shouldClaimEnvelope<T>(
  envelope: QueueEnvelope<T>,
  options?: ClaimQueueOptions,
): boolean {
  if (options?.claimAll) {
    return true;
  }
  if (options?.turnId) {
    return envelope.turn_id === options.turnId;
  }
  return envelope.turn_id === undefined;
}

async function claimQueueItems<T>(
  filePath: string,
  options?: ClaimQueueOptions,
): Promise<T[]> {
  return await withQueueLock(filePath, async () => {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const envelopes = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseQueueEnvelope<T>(line));
      const claimed: T[] = [];
      const remaining: QueueEnvelope<T>[] = [];
      for (const envelope of envelopes) {
        if (shouldClaimEnvelope(envelope, options)) {
          claimed.push(envelope.payload);
          continue;
        }
        remaining.push(envelope);
      }
      const rewritten = remaining.length
        ? `${remaining.map((item) => JSON.stringify(item)).join('\n')}\n`
        : '';
      const rewritePath = `${filePath}.${Date.now()}.${process.pid}.tmp`;
      await fs.writeFile(rewritePath, rewritten, 'utf8');
      try {
        await fs.rename(rewritePath, filePath);
      } catch (error) {
        await fs.unlink(rewritePath).catch(() => undefined);
        throw error;
      }
      return claimed;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  });
}

export async function appendOutboundMessage(
  conversationId: string,
  persistenceDir: string,
  message: SmolpawsOutboundMessage,
  options?: { turnId?: string },
): Promise<void> {
  await appendQueueItem(
    buildOutboxFilePath(conversationId, persistenceDir),
    {
      ...(options?.turnId ? { turn_id: options.turnId } : {}),
      payload: message,
    },
  );
}

export async function claimOutboundMessages(
  conversationId: string,
  persistenceDir: string,
  options?: ClaimQueueOptions,
): Promise<SmolpawsOutboundMessage[]> {
  return await claimQueueItems<SmolpawsOutboundMessage>(
    buildOutboxFilePath(conversationId, persistenceDir),
    options,
  );
}

export async function appendTaskCommand(
  conversationId: string,
  persistenceDir: string,
  command: SmolpawsTaskCommand,
  options?: { turnId?: string },
): Promise<void> {
  await appendQueueItem(
    buildTaskCommandFilePath(conversationId, persistenceDir),
    {
      ...(options?.turnId ? { turn_id: options.turnId } : {}),
      payload: command,
    },
  );
}

export async function claimTaskCommands(
  conversationId: string,
  persistenceDir: string,
  options?: ClaimQueueOptions,
): Promise<SmolpawsTaskCommand[]> {
  return await claimQueueItems<SmolpawsTaskCommand>(
    buildTaskCommandFilePath(conversationId, persistenceDir),
    options,
  );
}
