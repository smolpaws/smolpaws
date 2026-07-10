import { randomUUID } from 'node:crypto';

export interface Subscriber<T> {
  (event: T): Promise<void> | void;
  close?(): Promise<void> | void;
}

export class MaxSubscribersError extends Error {
  constructor(maxSubscribers: number) {
    super(`Subscriber limit reached (${maxSubscribers})`);
    this.name = 'MaxSubscribersError';
  }
}

export class PubSub<T> {
  private readonly subscribers = new Map<string, Subscriber<T>>();

  constructor(private readonly maxSubscribers: number | null = null) {}

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
    const subscribers = [...this.subscribers.entries()];
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
