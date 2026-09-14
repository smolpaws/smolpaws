/** Consume the established local voice-outbox producer into the durable relay outbox. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { queueMedia } from '../../../src/coordinator/outboundMedia.js';
import type { ScheduledLane } from '../../../src/coordinator/taskScheduler.js';
export function importVoiceOutbox(file: string, resolveLane: (jid: string) => ScheduledLane | undefined): number {
  const processing = `${file}.processing`;
  if (!existsSync(processing)) {
    try { renameSync(file, processing); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }
  const contents = readFileSync(processing, 'utf8');
  const batch = createHash('sha256').update(contents).digest('hex');
  let count = 0;
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as { jid?: string; oggPath?: string };
    if (typeof value.jid !== 'string' || typeof value.oggPath !== 'string') throw new Error('Invalid voice outbox record');
    const lane = resolveLane(value.jid);
    if (!lane) throw new Error('Voice outbox destination is not registered');
    // This private host-owned queue is the legacy control-scope producer, not an agent tool request.
    queueMedia({ ...lane, scopeId: 'main' }, { path: value.oggPath, media_type: 'audio', voice_note: true, mime_type: 'audio/ogg; codecs=opus' }, `voice:${batch}:${index}`);
    count += 1;
  }
  unlinkSync(processing);
  return count;
}
