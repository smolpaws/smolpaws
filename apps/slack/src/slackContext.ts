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

export function isAllowed(ctx: SlackEventContext, config: SlackConfig): boolean {
  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(ctx.userId)) {
    return false;
  }
  if (ctx.isDm) return true;
  if (config.allowedTeamIds.size > 0 && !config.allowedTeamIds.has(ctx.teamId)) {
    return false;
  }
  if (config.allowedChannelIds.size > 0 && !config.allowedChannelIds.has(ctx.channelId)) {
    return false;
  }
  return true;
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
