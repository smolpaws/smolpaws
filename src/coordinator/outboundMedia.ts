import { randomUUID } from 'node:crypto';
/** Immutable local attachments queued through the same durable delivery boundary as text. */
import { copyFileSync, mkdirSync, realpathSync, statSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
import type { ScheduledLane } from './taskScheduler.js';

export interface OutboundMedia {
  kind: 'current_thread_media'; path: string; mediaType: 'image' | 'video' | 'audio' | 'document';
  mimeType: string; fileName: string; caption?: string; voiceNote?: boolean;
}
export type MediaSender = (chatId: string, media: OutboundMedia, threadId?: string) => Promise<string | null>;
export function isMedia(value: unknown): value is OutboundMedia {
  return typeof value === 'object' && value !== null && (value as OutboundMedia).kind === 'current_thread_media';
}
export function validateMedia(media: OutboundMedia): void {
  if (!['image', 'video', 'audio', 'document'].includes(media.mediaType) || typeof media.path !== 'string' ||
      typeof media.fileName !== 'string' || typeof media.mimeType !== 'string') throw new Error('Invalid media payload');
  const file = statSync(media.path);
  if (!file.isFile() || file.size === 0) throw new Error('Media must be a nonempty file');
  if (media.voiceNote && (media.mediaType !== 'audio' || !media.mimeType.startsWith('audio/ogg'))) throw new Error('Voice notes require OGG/Opus audio');
}
const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg; codecs=opus', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.txt': 'text/plain' };
export function queueMedia(lane: ScheduledLane, action: Record<string, unknown>, actionId: string): string {
  if (!['whatsapp', 'slack', 'discord'].includes(lane.lane.platform)) throw new Error('This conversation has no outbound media bridge');
  const db = new Database(lane.relayDbPath);
  try {
    const store = new MessageWorkStore(db);
    const sourceKey = `media:${lane.conversationId}:${actionId}`;
    const previous = db.prepare("SELECT id FROM work WHERE kind='delivery' AND source_key=?").get(sourceKey) as { id: string } | undefined;
    if (previous) return previous.id;
    const source = realpathSync(path.resolve(lane.workingDir, String(action.path)));
    const root = realpathSync(lane.workingDir);
    const relative = path.relative(root, source);
    if (lane.scopeId !== 'main' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('Media must be inside this scope workspace');
    const media: OutboundMedia = { kind: 'current_thread_media', path: source,
      mediaType: action.media_type as OutboundMedia['mediaType'],
      mimeType: typeof action.mime_type === 'string' ? action.mime_type : mimeTypes[path.extname(source).toLowerCase()] ?? 'application/octet-stream',
      fileName: path.basename(source), ...(typeof action.caption === 'string' ? { caption: action.caption } : {}),
      ...(action.voice_note === true ? { voiceNote: true } : {}) };
    validateMedia(media);
    const directory = path.join(path.dirname(lane.relayDbPath), 'outbound-media');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, deterministicEventId('media', sourceKey) + path.extname(source));
    // Publish only a complete copy. Hard-link without replacement preserves first-attempt bytes.
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      copyFileSync(source, temporary); chmodSync(temporary, 0o600);
      try { linkSync(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { try { unlinkSync(temporary); } catch { /* no copy was created */ } }
    media.path = destination;
    return store.insertDelivery({ laneKey: lane.lane.laneKey, sourceKey, agentEventId: actionId, payload: media }, Date.now()).id;
  } finally { db.close(); }
}
