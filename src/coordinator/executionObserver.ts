import type { LaneDescriptor } from './types.js';

interface ExecutionLane { lane: LaneDescriptor; conversationId: string }
interface Options {
  lanes: () => readonly ExecutionLane[];
  status: (id: string, signal: AbortSignal) => Promise<string>;
  observe: (lane: LaneDescriptor, status: string) => void;
  onError: (error: unknown) => void;
}

/** Ephemeral presence uses current server state, never replayed events or durable intake success. */
export class ExecutionObserver {
  private readonly pending = new Map<string, AbortController>();
  private readonly known = new Map<string, ExecutionLane>();
  private readonly checked = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: Options) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 5_000);
    this.timer.unref?.();
  }

  refresh(): void {
    if (this.stopped) return;
    const lanes = this.options.lanes();
    const ids = new Set(lanes.map(item => item.conversationId));
    for (const [id, entry] of this.known) {
      if (ids.has(id)) continue;
      this.pending.get(id)?.abort();
      this.publish(entry.lane, 'unknown');
      this.known.delete(id);
      this.checked.delete(id);
    }
    for (const entry of lanes) {
      const id = entry.conversationId;
      this.known.set(id, entry);
      if (this.pending.has(id) || Date.now() - (this.checked.get(id) ?? -Infinity) < 5_000) continue;
      this.checked.set(id, Date.now());
      const controller = new AbortController();
      this.pending.set(id, controller);
      // Presence must never hold up integration, delivery, or a different conversation.
      void Promise.resolve().then(() => this.options.status(id, controller.signal)).then(status => {
        if (!this.stopped && !controller.signal.aborted) this.publish(entry.lane, status);
      }).catch(error => {
        if (!this.stopped && !controller.signal.aborted) {
          this.publish(entry.lane, 'unknown');
          this.options.onError(error);
        }
      }).finally(() => { if (this.pending.get(id) === controller) this.pending.delete(id); });
    }
  }

  /** Transport reconnect invalidates requests begun on the previous connection. */
  reconcile(): void {
    if (this.stopped) return;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.checked.clear();
    this.refresh();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.pending.values()) controller.abort();
    for (const { lane } of this.known.values()) this.publish(lane, 'unknown');
    this.known.clear();
  }

  private publish(lane: LaneDescriptor, status: string): void {
    try { this.options.observe(lane, status); }
    catch (error) { this.options.onError(error); }
  }
}
