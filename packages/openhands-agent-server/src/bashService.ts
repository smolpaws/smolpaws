import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bashCommandSchema, bashEventSchema, bashOutputSchema, type BashCommand, type BashEvent, type BashEventPage, type BashOutput, type ExecuteBashRequest } from './models.js';
import { PubSub, type Subscriber } from './pubSub.js';

const MAX_OUTPUT_CHARS = 1024 * 1024;

export interface BashEventServiceOptions {
  readonly bashEventsDir: string;
}

interface RunningCommand {
  child: ChildProcessWithoutNullStreams | null;
  stopRequested: boolean;
  timedOut: boolean;
  termination: Promise<void> | null;
  readonly closed: Promise<void>;
  readonly markClosed: () => void;
  readonly task: Promise<void>;
  readonly finish: () => void;
}

interface BashEventSearchOptions {
  readonly kind?: string | null;
  readonly commandId?: string | null;
  readonly timestampGte?: Date | null;
  readonly timestampLt?: Date | null;
  readonly orderGt?: number | null;
  readonly pageId?: string | null;
  readonly limit?: number;
  readonly sortOrder?: 'TIMESTAMP' | 'TIMESTAMP_DESC';
}

export class BashEventService {
  private closing = false;
  private readonly running = new Map<string, RunningCommand>();
  private readonly pubSub = new PubSub<BashEvent>(50);

  constructor(private readonly options: BashEventServiceOptions) {}

  async startBashCommand(request: ExecuteBashRequest): Promise<{ readonly command: BashCommand; readonly task: Promise<void> }> {
    if (this.closing) throw new Error('Bash service is closing.');
    const command = bashCommandSchema.parse({
      ...request,
      cwd: request.cwd ?? process.cwd(),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    let markClosed!: () => void, finish!: () => void;
    const entry: RunningCommand = {child:null,stopRequested:false,timedOut:false,termination:null,
      closed:new Promise<void>(resolve=>{markClosed=resolve;}),markClosed:()=>markClosed(),
      task:new Promise<void>(resolve=>{finish=resolve;}),finish:()=>finish()};
    // Register before publication so a subscriber may stop a not-yet-spawned ID.
    this.running.set(command.id,entry);
    try {
      await this.saveEvent(command);
      await this.pubSub.publish(command);
      void this.execute(command,entry).catch(async()=>{
        entry.markClosed();
        const failure=await this.saveOutput({command_id:command.id,order:0,exit_code:1,stderr:'Unable to start Bash command.'});
        await this.pubSub.publish(failure);
      }).catch(()=>console.error('bash_execution_cleanup_failed',{command_id:command.id})).finally(async()=>{await entry.termination;this.running.delete(command.id);entry.finish();});
      return {command,task:entry.task};
    } catch(error) { this.running.delete(command.id);entry.markClosed();entry.finish();throw error; }
  }

  async stopBashCommand(commandId:string):Promise<boolean> {
    const entry=this.running.get(commandId);
    if(entry===undefined)return (await this.getBashEvent(commandId))?.kind==='BashCommand';
    entry.stopRequested=true;
    if(entry.child===null || entry.child.pid===undefined)return true;
    await this.terminate(entry);
    await entry.task;
    return true;
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

  async searchBashEvents(options: BashEventSearchOptions = {}): Promise<BashEventPage> {
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
      const eventTimestamp = Date.parse(event.timestamp);
      if (options.timestampGte !== undefined && options.timestampGte !== null && eventTimestamp < options.timestampGte.getTime()) continue;
      if (options.timestampLt !== undefined && options.timestampLt !== null && eventTimestamp >= options.timestampLt.getTime()) continue;
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

  async deleteEventsOlderThan(cutoff: Date): Promise<number> {
    const cutoffPrefix = timestampPrefix(cutoff.toISOString());
    let count = 0;
    for (const file of await this.eventFiles()) {
      if (path.basename(file) >= cutoffPrefix) break;
      try {
        await fs.unlink(file);
        count += 1;
      } catch (error) {
        console.error('Failed to delete expired bash event', error);
      }
    }
    return count;
  }

  async runRetentionCleanupLoop(retentionSeconds: number, intervalSeconds = Math.max(60, retentionSeconds / 2), signal?: AbortSignal): Promise<void> {
    while (signal?.aborted !== true) {
      try {
        await this.deleteEventsOlderThan(new Date(Date.now() - retentionSeconds * 1000));
      } catch (error) {
        console.error('Bash event retention cleanup failed', error);
        await abortableDelay(Math.min(intervalSeconds, 60) * 1000, signal);
      }
      await abortableDelay(intervalSeconds * 1000, signal);
    }
  }

  async subscribeToEvents(subscriber: Subscriber<BashEvent>): Promise<string> {
    return this.pubSub.subscribe(subscriber);
  }

  async unsubscribeFromEvents(subscriberId: string): Promise<boolean> {
    return this.pubSub.unsubscribe(subscriberId);
  }

  async close(): Promise<void> {
    this.closing=true;
    const active=[...this.running.values()];
    for(const entry of active){entry.stopRequested=true;if(entry.child!==null)void this.terminate(entry);}
    await Promise.all(active.map(entry=>entry.task));
    await this.pubSub.close();
  }

  private terminate(entry:RunningCommand):Promise<void> {
    if(entry.termination!==null)return entry.termination;
    const child=entry.child;
    if(child===null || child.pid===undefined)return Promise.resolve();
    const signal=(value: 'SIGTERM' | 'SIGKILL'):void=>{
      try{process.kill(-child.pid!,value);}catch{try{child.kill(value);}catch{ /* already exited */ }}
    };
    entry.termination=(async()=>{
      signal('SIGTERM');
      const deadline=Date.now()+1000;
      // Root exit does not imply group exit: descendants may redirect both pipes.
      const alive=()=>{try{process.kill(-child.pid!,0);return true;}catch{return false;}};
      while(alive() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
      if(alive())signal('SIGKILL');
      await entry.closed;
    })();
    return entry.termination;
  }

  private async execute(command: BashCommand, entry:RunningCommand): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn('bash', ['-lc', command.command], { cwd: command.cwd ?? process.cwd(), env: process.env, detached: true });
      entry.child=child;
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
        entry.timedOut=true;entry.stopRequested=true;
        void this.terminate(entry);
      }, Math.max(1, command.timeout ?? 300) * 1000);

      child.stdout.on('data', (chunk: Buffer | string) => append(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer | string) => append(chunk, 'stderr'));
      child.on('error', () => {entry.markClosed();finalize(1,'Unable to start Bash command.');});
      child.on('close', (code,signal) => {
        entry.markClosed();
        finalize(entry.timedOut?-1:typeof code==='number'?code:signal===null?1:-(constants.signals[signal]??1),
          entry.timedOut?`Command timed out after ${command.timeout} seconds.`:'');
      });
      child.on('spawn',()=>{if(entry.stopRequested || this.closing)void this.terminate(entry);});
      if(entry.stopRequested || this.closing)void this.terminate(entry);
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

function abortableDelay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
