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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(item)}\n`, 'utf8');
}

async function claimQueueItems<T>(
  filePath: string,
  options?: { turnId?: string },
): Promise<T[]> {
  const processingPath = `${filePath}.${Date.now()}.processing`;
  try {
    await fs.rename(filePath, processingPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    const raw = await fs.readFile(processingPath, 'utf8');
    const envelopes = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as QueueEnvelope<T>);
    const claimed: T[] = [];
    const remaining: QueueEnvelope<T>[] = [];
    for (const envelope of envelopes) {
      if (!options?.turnId || envelope.turn_id === options.turnId) {
        claimed.push(envelope.payload);
        continue;
      }
      remaining.push(envelope);
    }
    if (remaining.length > 0) {
      await fs.writeFile(
        filePath,
        `${remaining.map((item) => JSON.stringify(item)).join('\n')}\n`,
        'utf8',
      );
    }
    await fs.unlink(processingPath);
    return claimed;
  } catch (error) {
    await fs.rename(processingPath, filePath).catch(() => undefined);
    throw error;
  }
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
  options?: { turnId?: string },
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
  options?: { turnId?: string },
): Promise<SmolpawsTaskCommand[]> {
  return await claimQueueItems<SmolpawsTaskCommand>(
    buildTaskCommandFilePath(conversationId, persistenceDir),
    options,
  );
}
