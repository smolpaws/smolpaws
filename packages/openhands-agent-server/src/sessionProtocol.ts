import type { Event } from '@smolpaws/openhands-agent';

/**
 * Wire protocol for `/sockets/session/{conversation_id}`.
 *
 * Not built on `Event`: the legacy endpoint sends the same class it persists and
 * validates. Here `Event` rides inside an envelope, untouched, and protocol
 * fields live on the envelope. The URL is the protocol version — no handshake,
 * no `protocol` field.
 *
 * Delivery rules:
 * 1. `Durable` survives a reconnect via `after_seq`; within a connection it may
 *    be dropped, which is what lets a slow consumer be disconnected instead of
 *    blocking the publisher.
 * 2. `Delta` may be dropped freely; a gap marks the slot lossy and the real text
 *    arrives with the durable message.
 * 3. Progress frames are never replayed.
 * 4. No ordering is promised between two open items.
 *
 * The `item_started` / `delta` / `item_aborted` families are defined for wire
 * compatibility but never produced yet: upstream gates their emission on a
 * `StreamContext` this server does not implement (#4682). Until then the socket
 * is a durable-only channel and streaming deltas are dropped rather than
 * forwarded.
 */

// PROVISIONAL. The cap is meant to be derived from a measured frame-size
// distribution, which has not been done yet. Do not treat these as tuned.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_BYTES = 4 * MAX_FRAME_BYTES;

interface SessionFrameBase {
  readonly type: string;
}

export interface SyncFrame extends SessionFrameBase {
  readonly type: 'sync';
  readonly from_seq: number | null;
  readonly through_seq: number | null;
}

export interface DurableFrame extends SessionFrameBase {
  readonly type: 'durable';
  readonly seq: number;
  readonly event: Event;
}

export interface TransientFrame extends SessionFrameBase {
  readonly type: 'transient';
  readonly event: Event;
}

export interface ErrorFrame extends SessionFrameBase {
  readonly type: 'error';
  readonly code: string;
  readonly detail: string;
}

export type SessionFrame = SyncFrame | DurableFrame | TransientFrame | ErrorFrame;

function frameWithNulls(frame: Record<string, unknown>): string {
  // Upstream serializes frames with ``exclude_none=True``; null-valued fields on
  // sync frames carry meaning only by their presence or absence, so reproduce
  // that here without dropping nulls that a durable event legitimately embeds.
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (value === null) continue;
    clean[key] = value;
  }
  return JSON.stringify(clean);
}

export function serializeSessionFrame(frame: SessionFrame): string {
  return frameWithNulls(frame as unknown as Record<string, unknown>);
}