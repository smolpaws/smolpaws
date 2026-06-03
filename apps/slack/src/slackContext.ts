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
