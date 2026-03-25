/**
 * Guards against duplicate background loops caused by WhatsApp reconnections.
 *
 * Each Baileys reconnection fires `connection === 'open'` again.
 * Without guards, startMessageLoop / startSchedulerLoop / setInterval calls
 * accumulate, causing duplicate message processing.
 */

export class ConnectionGuards {
  private _messageLoopRunning = false;
  private _schedulerStarted = false;
  private _groupSyncTimerId: ReturnType<typeof setInterval> | undefined;

  /** Returns true only on the first call — subsequent calls return false. */
  tryStartMessageLoop(): boolean {
    if (this._messageLoopRunning) return false;
    this._messageLoopRunning = true;
    return true;
  }

  /** Returns true only on the first call — subsequent calls return false. */
  tryStartScheduler(): boolean {
    if (this._schedulerStarted) return false;
    this._schedulerStarted = true;
    return true;
  }

  /**
   * Replace the group sync interval. Clears any previous timer
   * so only one interval is active at a time.
   */
  replaceGroupSyncInterval(callback: () => void, intervalMs: number): void {
    if (this._groupSyncTimerId) clearInterval(this._groupSyncTimerId);
    this._groupSyncTimerId = setInterval(callback, intervalMs);
  }

  /** Visible for testing. */
  get messageLoopRunning(): boolean {
    return this._messageLoopRunning;
  }

  get schedulerStarted(): boolean {
    return this._schedulerStarted;
  }

  get groupSyncTimerId(): ReturnType<typeof setInterval> | undefined {
    return this._groupSyncTimerId;
  }

  /** Clean up for tests. */
  dispose(): void {
    if (this._groupSyncTimerId) clearInterval(this._groupSyncTimerId);
    this._groupSyncTimerId = undefined;
  }
}
