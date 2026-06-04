import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SlackConfig } from './config.js';

export type SlackEventContext = {
  teamId: string;
  channelId: string;
  userId: string;
  ts: string;
  threadTs?: string;
  text: string;
  isDm: boolean;
  botUserId: string;
};

export function buildConversationId(ctx: SlackEventContext): string {
  if (ctx.isDm) {
    return `slack-im-${ctx.teamId}-${ctx.channelId}`;
  }
  const rootTs = ctx.threadTs ?? ctx.ts;
  return `slack-thread-${ctx.teamId}-${ctx.channelId}-${rootTs}`;
}

export function replyThreadTs(ctx: SlackEventContext): string {
  return ctx.threadTs ?? ctx.ts;
}

export function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

export type ThreadMessage = {
  user: string;
  text: string;
  ts: string;
};

const EXCLUDED_THREAD_MESSAGE_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'pinned_item',
  'tombstone',
]);

export function isThreadContextMessageSubtype(subtype?: string): boolean {
  return !subtype || !EXCLUDED_THREAD_MESSAGE_SUBTYPES.has(subtype);
}

export function isPriorSlackTs(ts: string, currentTs: string): boolean {
  const [sec1Raw, frac1Raw = ''] = ts.split('.', 2);
  const [sec2Raw, frac2Raw = ''] = currentTs.split('.', 2);
  const sec1 = Number.parseInt(sec1Raw, 10);
  const sec2 = Number.parseInt(sec2Raw, 10);
  if (!Number.isFinite(sec1) || !Number.isFinite(sec2)) {
    return false;
  }
  if (sec1 !== sec2) {
    return sec1 < sec2;
  }
  const maxFracLen = Math.max(frac1Raw.length, frac2Raw.length, 1);
  const frac1 = Number.parseInt(frac1Raw.padEnd(maxFracLen, '0'), 10);
  const frac2 = Number.parseInt(frac2Raw.padEnd(maxFracLen, '0'), 10);
  if (!Number.isFinite(frac1) || !Number.isFinite(frac2)) {
    return false;
  }
  return frac1 < frac2;
}

function isSlackUserMentionId(id: string): boolean {
  return id.startsWith('U') || id.startsWith('W');
}

export function formatThreadContext(messages: ThreadMessage[], currentTs: string, botUserId: string): string {
  const prior = messages.filter((m) => isPriorSlackTs(m.ts, currentTs));
  if (prior.length === 0) return '';
  const lines = prior.map((m) => {
    const who = m.user === botUserId ? 'smolpaws' : isSlackUserMentionId(m.user) ? `<@${m.user}>` : m.user;
    const cleanText = m.text.replace(new RegExp(`<@${botUserId}>`, 'g'), '@smolpaws');
    return `${who}: ${cleanText}`;
  });
  return `[Thread context]\n${lines.join('\n')}\n\n[Current message]\n`;
}

export type AllowResult = 'allowed' | 'denied' | 'guest';

export function checkAccess(ctx: SlackEventContext, config: SlackConfig): AllowResult {
  // Team and channel gates always apply for non-DMs
  if (!ctx.isDm) {
    if (config.allowedTeamIds.size > 0 && !config.allowedTeamIds.has(ctx.teamId)) {
      return 'denied';
    }
    if (config.allowedChannelIds.size > 0 && !config.allowedChannelIds.has(ctx.channelId)) {
      return 'denied';
    }
  }
  // Allowlisted users always pass
  if (config.allowedUserIds.has(ctx.userId)) return 'allowed';
  // No user allowlist configured → everyone is allowed
  if (config.allowedUserIds.size === 0) return 'allowed';
  // Non-allowlisted user with active allowlist → guest (rate-limited)
  return 'guest';
}

const DEFAULT_GUEST_LIMIT = 5;
const DEFAULT_RATE_FILE = `${process.env.HOME}/.smolpaws/slack/guest-usage.json`;

type GuestUsageEntry = { count: number; first_at: string };
type GuestUsageData = Record<string, GuestUsageEntry>;

export class GuestRateLimiter {
  private filePath: string;
  private limit: number;

  constructor(filePath?: string, limit?: number) {
    this.filePath = filePath ?? DEFAULT_RATE_FILE;
    this.limit = limit ?? DEFAULT_GUEST_LIMIT;
  }

  isWithinLimit(userId: string): boolean {
    const data = this.load();
    const entry = data[userId];
    if (!entry) return true;
    return entry.count < this.limit;
  }

  record(userId: string): void {
    const data = this.load();
    const entry = data[userId];
    if (entry) {
      entry.count += 1;
    } else {
      data[userId] = { count: 1, first_at: new Date().toISOString() };
    }
    this.save(data);
  }

  private load(): GuestUsageData {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private save(data: GuestUsageData): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n');
    } catch {
      // best-effort — don't crash on write failure
    }
  }
}

const MENTIONED_THREADS_MAX = 1000;

export class MentionedThreadTracker {
  private threads = new Set<string>();

  track(threadTs: string): void {
    // Delete first so re-tracking refreshes insertion order.
    // Set.add on an existing value is a no-op for ordering.
    this.threads.delete(threadTs);
    this.threads.add(threadTs);
    if (this.threads.size > MENTIONED_THREADS_MAX) {
      const iter = this.threads.values();
      for (let i = 0; i < MENTIONED_THREADS_MAX / 2; i++) {
        this.threads.delete(iter.next().value as string);
      }
    }
  }

  isTracked(threadTs: string): boolean {
    return this.threads.has(threadTs);
  }
}

const DEDUP_TTL_MS = 60_000;

export class MessageDeduplicator {
  private seen = new Map<string, number>();

  isDuplicate(key: string): boolean {
    const now = Date.now();
    this.prune(now);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }

  private prune(now: number): void {
    if (this.seen.size < 200) return;
    // Map preserves insertion order — oldest entries come first.
    // Break on first non-expired entry since all subsequent are newer.
    for (const [k, ts] of this.seen) {
      if (now - ts > DEDUP_TTL_MS) this.seen.delete(k);
      else break;
    }
  }
}
