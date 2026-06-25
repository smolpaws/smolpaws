/**
 * Transport-neutral burst coalescer for bridge ingress.
 *
 * When a user fires several messages in quick succession, dispatching each one
 * as its own agent turn is wasteful and races: the turns interleave and the
 * agent answers the first line before it has seen the rest. This coalescer
 * buffers messages per conversation for a short debounce window, then flushes
 * them as a single combined turn.
 *
 * It is deliberately platform-agnostic — it knows nothing about Slack, Discord,
 * or the agent server. A caller submits a `(key, text, flush)` triple; the
 * coalescer joins the buffered text and invokes the *latest* submitted `flush`
 * so the reply lands on the most recent message's context.
 *
 * Inspired by Hermes' gateway-level text debounce (TextDebounceState /
 * merge_pending_message_event), adapted for SmolPaws' bridge layer.
 *
 * Timers are injectable so the behaviour is deterministic under test.
 */

/** Flush a coalesced burst. Receives the combined text of all buffered
 * messages for the conversation, joined newest-last. */
export type CoalescedFlush = (combinedText: string) => Promise<void>;

export type TimerHandle = ReturnType<typeof setTimeout>;

export type MessageCoalescerOptions = {
  /** Debounce window in milliseconds. 0 (or negative) disables coalescing —
   * every submission flushes immediately, preserving legacy behaviour. */
  windowMs: number;
  /** Schedule a flush. Defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** Cancel a scheduled flush. Defaults to clearTimeout. */
  clearTimer?: (handle: TimerHandle) => void;
  /** Optional sink for internal errors (e.g. a flush rejecting). */
  onError?: (error: unknown, key: string) => void;
};

type PendingBurst = {
  /** Buffered message texts, in arrival order. */
  texts: string[];
  /** The flush from the most recently submitted message. */
  flush: CoalescedFlush;
  /** Active debounce timer, if any. */
  timer: TimerHandle | null;
};

export class MessageCoalescer {
  private readonly windowMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly onError?: (error: unknown, key: string) => void;
  private readonly pending = new Map<string, PendingBurst>();

  constructor(options: MessageCoalescerOptions) {
    this.windowMs = options.windowMs;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.onError = options.onError;
  }

  /** Whether coalescing is active (a positive window was configured). */
  get enabled(): boolean {
    return this.windowMs > 0;
  }

  /** Number of conversations with a buffered, not-yet-flushed burst. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Submit a message for a conversation. With coalescing disabled the flush
   * runs immediately with just this text. Otherwise the text is buffered and a
   * debounce timer (re)started; when it fires, the latest flush runs with all
   * buffered texts joined by a newline.
   */
  submit(key: string, text: string, flush: CoalescedFlush): void {
    if (!this.enabled) {
      void this.invoke(key, flush, text);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.texts.push(text);
      existing.flush = flush;
      if (existing.timer !== null) this.clearTimer(existing.timer);
      existing.timer = this.setTimer(() => this.flushKey(key), this.windowMs);
      return;
    }

    const burst: PendingBurst = { texts: [text], flush, timer: null };
    burst.timer = this.setTimer(() => this.flushKey(key), this.windowMs);
    this.pending.set(key, burst);
  }

  /** Flush a conversation's buffered burst immediately, if any. */
  flushKey(key: string): void {
    const burst = this.pending.get(key);
    if (!burst) return;
    if (burst.timer !== null) this.clearTimer(burst.timer);
    this.pending.delete(key);
    void this.invoke(key, burst.flush, burst.texts.join('\n'));
  }

  /** Cancel any pending bursts without flushing (e.g. on shutdown). */
  clear(): void {
    for (const burst of this.pending.values()) {
      if (burst.timer !== null) this.clearTimer(burst.timer);
    }
    this.pending.clear();
  }

  private async invoke(key: string, flush: CoalescedFlush, text: string): Promise<void> {
    try {
      await flush(text);
    } catch (error) {
      if (this.onError) this.onError(error, key);
      else throw error;
    }
  }
}
