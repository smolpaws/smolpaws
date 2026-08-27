/**
 * Deterministic identifiers for the coordinator.
 *
 * Intake events use a deterministic UUIDv5 derived from the platform + stable source message id, so a
 * lost append response is safe to retry: agent-server returns the existing event for the same id (ADR §8
 * idempotent-append delta). Implemented per RFC 4122 §4.3 (SHA-1, namespaced) with node:crypto.
 */
import { createHash } from 'node:crypto';

/** A fixed namespace UUID for SmolPaws message-work identities (randomly chosen, stable forever). */
export const SMOLPAWS_MESSAGE_NAMESPACE = '6f3a1c2e-9b4d-5e7a-8c1f-2d3b4a5c6e7f';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** RFC 4122 v5 (SHA-1) UUID from a namespace UUID and a name. */
export function uuidv5(name: string, namespace: string = SMOLPAWS_MESSAGE_NAMESPACE): string {
  const hash = createHash('sha1');
  hash.update(uuidToBytes(namespace));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic agent event id for an inbound platform message. */
export function deterministicEventId(platform: string, sourceMessageId: string): string {
  return uuidv5(`event:${platform}:${sourceMessageId}`);
}

/** Deterministic conversation id for a lane (stable across restarts / re-resolution). */
export function deterministicConversationId(laneKey: string): string {
  return uuidv5(`conversation:${laneKey}`);
}
