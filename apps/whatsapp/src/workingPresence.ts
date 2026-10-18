interface Run { chat: string; updated: number }

/** Best-effort native composing presence. No text notifications and no durable working flags. */
export class WorkingPresence {
  private connected = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly runs = new Map<string, Run>();
  private readonly composing = new Set<string>();
  private readonly retry = new Set<string>();
  private readonly pending = new Map<string, object>();

  constructor(private readonly send: (chat: string, active: boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void) {}

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    // Reconnect needs a fresh authoritative status, not a remembered running flag.
    this.runs.clear();
    this.timer = setInterval(() => this.refresh(), 5_000);
    this.timer.unref?.();
  }

  observe(id: string, chat: string, status: string): void {
    if (!this.connected) return;
    const previous = this.runs.get(id)?.chat;
    if (status === 'running') this.runs.set(id, { chat, updated: Date.now() });
    else this.runs.delete(id);
    if (previous && previous !== chat) this.update(previous);
    this.update(chat);
  }

  disconnect(): void {
    this.connected = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.runs.clear();
    // A dead socket must not hold the replacement connection behind its unfinished sends.
    this.pending.clear();
    for (const chat of new Set([...this.composing, ...this.retry])) this.update(chat);
  }

  private active(chat: string): boolean {
    return this.connected && [...this.runs.values()].some(run => run.chat === chat && Date.now() - run.updated < 15_000);
  }

  private refresh(): void {
    for (const [id, run] of this.runs) if (Date.now() - run.updated >= 15_000) this.runs.delete(id);
    for (const chat of new Set([...this.composing, ...this.retry, ...[...this.runs.values()].map(run => run.chat)])) this.update(chat, true);
  }

  private update(chat: string, refresh = false): void {
    const active = this.active(chat);
    if (this.pending.has(chat)) return;
    if ((!refresh || !active) && !this.retry.has(chat) && active === this.composing.has(chat)) return;
    const token = {};
    this.pending.set(chat, token);
    if (active) this.composing.add(chat);
    else this.composing.delete(chat);
    let sent: Promise<void>;
    try { sent = this.send(chat, active); } catch (error) { sent = Promise.reject(error); }
    let timeout: ReturnType<typeof setTimeout>;
    const bounded = Promise.race([sent, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Presence send timed out')), 5_000);
      timeout.unref?.();
    })]);
    void bounded.then(() => {
      if (this.pending.get(chat) === token) this.retry.delete(chat);
    }, error => {
      if (this.pending.get(chat) === token) this.retry.add(chat);
      this.onError(error);
    }).finally(() => {
      clearTimeout(timeout);
      if (this.pending.get(chat) !== token) return;
      this.pending.delete(chat);
      // A final/pause arriving during an in-flight composing update must win.
      if (this.active(chat) !== active) this.update(chat);
    });
  }
}
