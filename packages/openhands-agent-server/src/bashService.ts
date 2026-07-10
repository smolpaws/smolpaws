import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bashCommandSchema, bashEventSchema, bashOutputSchema, type BashCommand, type BashEvent, type BashEventPage, type BashOutput, type ExecuteBashRequest } from './models.js';
import { PubSub, type Subscriber } from './pubSub.js';

const MAX_OUTPUT_CHARS = 1024 * 1024;

export interface BashEventServiceOptions {
  readonly bashEventsDir: string;
}

export class BashEventService {
  private readonly pubSub = new PubSub<BashEvent>(50);

  constructor(private readonly options: BashEventServiceOptions) {}

  async startBashCommand(request: ExecuteBashRequest): Promise<{ readonly command: BashCommand; readonly task: Promise<void> }> {
    const command = bashCommandSchema.parse({
      ...request,
      cwd: request.cwd ?? process.cwd(),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await this.saveEvent(command);
    await this.pubSub.publish(command);
    const task = this.execute(command);
    return { command, task };
  }

  async executeBashCommand(request: ExecuteBashRequest): Promise<BashOutput> {
    const { command, task } = await this.startBashCommand(request);
    await task;
    const page = await this.searchBashEvents({ commandId: command.id, kind: 'BashOutput' });
    const output = page.items.at(-1);
    if (output?.kind === 'BashOutput') return output;
    return this.saveOutput({ command_id: command.id, order: 0, exit_code: -1, stderr: 'No bash output produced.' });
  }

  async getBashEvent(eventId: string): Promise<BashEvent | null> {
    const file = (await this.eventFiles()).find((candidate) => candidate.endsWith(`_${eventId}.json`));
    return file === undefined ? null : this.loadEvent(file);
  }

  async batchGetBashEvents(eventIds: readonly string[]): Promise<Array<BashEvent | null>> {
    return Promise.all(eventIds.map((eventId) => this.getBashEvent(eventId)));
  }

  async searchBashEvents(options: { readonly kind?: string | null; readonly commandId?: string | null; readonly orderGt?: number | null; readonly pageId?: string | null; readonly limit?: number; readonly sortOrder?: 'TIMESTAMP' | 'TIMESTAMP_DESC' } = {}): Promise<BashEventPage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    const files = await this.eventFiles();
    const ordered = options.sortOrder === 'TIMESTAMP_DESC' ? [...files].reverse() : files;
    const startIndex = options.pageId === undefined || options.pageId === null ? 0 : Math.max(0, ordered.findIndex((file) => path.basename(file) === options.pageId));
    const items: BashEvent[] = [];
    let next_page_id: string | null = null;
    for (const file of ordered.slice(startIndex)) {
      if (items.length >= limit) {
        next_page_id = path.basename(file);
        break;
      }
      const event = await this.loadEvent(file);
      if (event === null) continue;
      if (options.kind !== undefined && options.kind !== null && event.kind !== options.kind) continue;
      if (options.commandId !== undefined && options.commandId !== null && event.kind === 'BashOutput' && event.command_id !== options.commandId) continue;
      if (options.commandId !== undefined && options.commandId !== null && event.kind === 'BashCommand' && event.id !== options.commandId) continue;
      if (options.orderGt !== undefined && options.orderGt !== null && event.kind === 'BashOutput' && event.order <= options.orderGt) continue;
      items.push(event);
    }
    return { items, next_page_id };
  }

  async clearAllEvents(): Promise<number> {
    const files = await this.eventFiles();
    await Promise.all(files.map(async (file) => fs.unlink(file).catch(() => undefined)));
    return files.length;
  }

  async subscribeToEvents(subscriber: Subscriber<BashEvent>): Promise<string> {
    return this.pubSub.subscribe(subscriber);
  }

  async unsubscribeFromEvents(subscriberId: string): Promise<boolean> {
    return this.pubSub.unsubscribe(subscriberId);
  }

  async close(): Promise<void> {
    await this.pubSub.close();
  }

  private async execute(command: BashCommand): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn('bash', ['-lc', command.command], { cwd: command.cwd ?? process.cwd(), env: process.env, detached: true });
      let stdout = '';
      let stderr = '';
      let finished = false;
      let order = 0;
      let writeQueue = Promise.resolve();

      const finalize = (exitCode: number, extraStderr = ''): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        const currentOrder = order;
        writeQueue = writeQueue
          .then(() => this.saveOutput({ command_id: command.id, order: currentOrder, exit_code: exitCode, stdout: stdout || null, stderr: `${stderr}${extraStderr}` || null }))
          .then((event) => this.pubSub.publish(event))
          .catch((error: unknown) => console.error('Failed to save final bash output', error))
          .finally(resolve);
      };

      const append = (chunk: Buffer | string, target: 'stdout' | 'stderr'): void => {
        if (target === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
        while (stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS) {
          const stdoutChunk = stdout.length > MAX_OUTPUT_CHARS ? stdout.slice(0, MAX_OUTPUT_CHARS) : null;
          const stderrChunk = stderr.length > MAX_OUTPUT_CHARS ? stderr.slice(0, MAX_OUTPUT_CHARS) : null;
          if (stdoutChunk !== null) stdout = stdout.slice(MAX_OUTPUT_CHARS);
          if (stderrChunk !== null) stderr = stderr.slice(MAX_OUTPUT_CHARS);
          const currentOrder = order;
          writeQueue = writeQueue
            .then(() => this.saveOutput({ command_id: command.id, order: currentOrder, stdout: stdoutChunk, stderr: stderrChunk }))
            .then((event) => this.pubSub.publish(event))
            .catch((error: unknown) => console.error('Failed to save bash output chunk', error));
          order += 1;
        }
      };

      const timeout = setTimeout(() => {
        try {
          if (child.pid === undefined) child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        finalize(-1, `Command timed out after ${command.timeout} seconds.`);
      }, Math.max(1, command.timeout ?? 300) * 1000);

      child.stdout.on('data', (chunk: Buffer | string) => append(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer | string) => append(chunk, 'stderr'));
      child.on('error', (error) => finalize(1, error.message));
      child.on('close', (code) => finalize(typeof code === 'number' ? code : 1));
    });
  }

  private async saveOutput(input: { readonly command_id: string; readonly order: number; readonly exit_code?: number | null; readonly stdout?: string | null; readonly stderr?: string | null }): Promise<BashOutput> {
    const event = bashOutputSchema.parse({
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await this.saveEvent(event);
    return event;
  }

  private async saveEvent(event: BashEvent): Promise<void> {
    await fs.mkdir(this.options.bashEventsDir, { recursive: true });
    await fs.writeFile(path.join(this.options.bashEventsDir, `${timestampPrefix(event.timestamp)}_${event.kind}_${event.kind === 'BashOutput' ? `${event.command_id}_` : ''}${event.id}.json`), `${JSON.stringify(event, null, 2)}\n`, 'utf8');
  }

  private async loadEvent(filePath: string): Promise<BashEvent | null> {
    try {
      return bashEventSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
      console.error('Skipping corrupted bash event', error);
      return null;
    }
  }

  private async eventFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.options.bashEventsDir).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    });
    return entries.filter((entry) => entry.endsWith('.json')).sort().map((entry) => path.join(this.options.bashEventsDir, entry));
  }
}

function timestampPrefix(timestamp: string): string {
  return timestamp.replace(/[-:.TZ]/gu, '').padEnd(20, '0');
}

function isErrno(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

