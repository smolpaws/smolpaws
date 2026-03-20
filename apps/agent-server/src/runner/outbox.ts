import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SmolpawsOutboundMessage,
  SmolpawsTaskCommand,
} from '../shared/runner.js';
import { buildConversationDirPath } from './conversationService.js';

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
  item: T,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(item)}\n`, 'utf8');
}

async function claimQueueItems<T>(filePath: string): Promise<T[]> {
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
    const items = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
    await fs.unlink(processingPath);
    return items;
  } catch (error) {
    await fs.rename(processingPath, filePath).catch(() => undefined);
    throw error;
  }
}

export async function appendOutboundMessage(
  conversationId: string,
  persistenceDir: string,
  message: SmolpawsOutboundMessage,
): Promise<void> {
  await appendQueueItem(
    buildOutboxFilePath(conversationId, persistenceDir),
    message,
  );
}

export async function claimOutboundMessages(
  conversationId: string,
  persistenceDir: string,
): Promise<SmolpawsOutboundMessage[]> {
  return await claimQueueItems<SmolpawsOutboundMessage>(
    buildOutboxFilePath(conversationId, persistenceDir),
  );
}

export async function appendTaskCommand(
  conversationId: string,
  persistenceDir: string,
  command: SmolpawsTaskCommand,
): Promise<void> {
  await appendQueueItem(
    buildTaskCommandFilePath(conversationId, persistenceDir),
    command,
  );
}

export async function claimTaskCommands(
  conversationId: string,
  persistenceDir: string,
): Promise<SmolpawsTaskCommand[]> {
  return await claimQueueItems<SmolpawsTaskCommand>(
    buildTaskCommandFilePath(conversationId, persistenceDir),
  );
}
