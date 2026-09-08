import { randomUUID } from 'node:crypto';

export interface Subscriber<T> {
  (event: T): Promise<void> | void;
  close?(): Promise<void> | void;
  /**
   * Deltas arrive at token rate; consumers opt in rather than inherit them.
   * When false (the default), `StreamingDeltaEvent`s are not fanned out to this
   * subscriber. Mirrors upstream `Subscriber.receives_streaming_deltas`.
   */
  receivesStreamingDeltas?: boolean;
}

export class MaxSubscribersError extends Error {
  constructor(maxSubscribers: number) {
    super(`Subscriber limit reached (${maxSubscribers})`);
    this.name = 'MaxSubscribersError';
  }
}

export class PubSub<T> {
  private readonly subscribers = new Map<string, Subscriber<T>>();
  private readonly matchesStreamingDelta: ((event: T) => boolean) | null;

  constructor(
    private readonly maxSubscribers: number | null = null,
    options: { readonly isStreamingDelta?: (event: T) => boolean } = {},
  ) {
    this.matchesStreamingDelta = options.isStreamingDelta ?? null;
  }

  subscribe(subscriber: Subscriber<T>): string {
    if (this.maxSubscribers !== null && this.subscribers.size >= this.maxSubscribers) {
      throw new MaxSubscribersError(this.maxSubscribers);
    }
    const id = randomUUID();
    this.subscribers.set(id, subscriber);
    return id;
  }

  unsubscribe(subscriberId: string): boolean {
    return this.subscribers.delete(subscriberId);
  }

  async publish(event: T): Promise<void> {
    let subscribers = [...this.subscribers.entries()];
    if (this.matchesStreamingDelta !== null && this.matchesStreamingDelta(event)) {
      subscribers = subscribers.filter(([, subscriber]) => subscriber.receivesStreamingDeltas === true);
    }
    for (const [subscriberId, subscriber] of subscribers) {
      try {
        const result = subscriber(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => console.error('pubsub_subscriber_error', { subscriberId, error }));
        }
      } catch (error) {
        console.error('pubsub_subscriber_error', { subscriberId, error });
      }
    }
  }

  async close(): Promise<void> {
    const subscribers = [...this.subscribers.values()];
    this.subscribers.clear();
    await Promise.all(
      subscribers.map(async (subscriber) => {
        await subscriber.close?.();
      }),
    );
  }
}
