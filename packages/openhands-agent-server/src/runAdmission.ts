/** One server-wide capacity pool for initialization and actual conversation work. */
export class ConversationRunLimitExceeded extends Error {
  constructor(message = 'Conversation capacity is full. Retry after an active run completes.') {
    super(message);
    this.name = 'ConversationRunLimitExceeded';
  }
}

interface Reservation {
  references: number;
  readonly release: () => void;
}

export class RunSlot {
  private released = false;
  constructor(private readonly reservation: Reservation) {}

  share(): RunSlot {
    if (this.released) throw new Error('Cannot share a released run reservation.');
    this.reservation.references++;
    return new RunSlot(this.reservation);
  }

  release(): boolean {
    if (this.released) return false;
    this.released = true;
    if (--this.reservation.references !== 0) return false;
    this.reservation.release();
    return true;
  }
}

interface Waiter {
  readonly resolve: (slot: RunSlot) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

export class RunAdmission {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(maximum = 10) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('maxConcurrentRuns must be a positive integer');
    this.available = maximum;
  }

  tryAcquire(): RunSlot {
    if (this.available === 0) throw new ConversationRunLimitExceeded();
    this.available--;
    return this.slot();
  }

  acquire(signal?: AbortSignal): Promise<RunSlot> {
    if (signal?.aborted === true) return Promise.reject(aborted());
    if (this.available > 0) return Promise.resolve(this.tryAcquire());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(aborted());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private slot(): RunSlot {
    return new RunSlot({
      references: 1,
      release: () => {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.available++;
          return;
        }
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.resolve(this.slot());
      },
    });
  }
}

function aborted(): Error {
  return Object.assign(new Error('Conversation admission cancelled.'), { name: 'AbortError' });
}
