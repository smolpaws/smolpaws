import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationId,
  checkAccess,
  formatThreadContext,
  GuestRateLimiter,
  isPriorSlackTs,
  isThreadContextMessageSubtype,
  MentionedThreadTracker,
  MessageDeduplicator,
  replyThreadTs,
  stripBotMention,
  type SlackEventContext,
} from '../slackContext.js';
import type { SlackConfig } from '../config.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeCtx(overrides: Partial<SlackEventContext> = {}): SlackEventContext {
  return {
    teamId: 'T06P',
    channelId: 'C123',
    userId: 'U456',
    ts: '1717200000.000100',
    text: '<@U0BOT> hello',
    isDm: false,
    botUserId: 'U0BOT',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SlackConfig> = {}): SlackConfig {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    runnerUrl: 'http://127.0.0.1:8788',
    allowedTeamIds: new Set(),
    allowedChannelIds: new Set(),
    allowedUserIds: new Set(),
    logLevel: 'silent',
    ...overrides,
  };
}

// --- buildConversationId ---

test('buildConversationId: DM uses slack-im with team and channel', () => {
  const ctx = makeCtx({ isDm: true, channelId: 'D08X' });
  assert.equal(buildConversationId(ctx), 'slack-im-T06P-D08X');
});

test('buildConversationId: channel message without thread uses ts as root', () => {
  const ctx = makeCtx({ ts: '1717200000.000100', threadTs: undefined });
  assert.equal(buildConversationId(ctx), 'slack-thread-T06P-C123-1717200000.000100');
});

test('buildConversationId: threaded reply uses thread_ts', () => {
  const ctx = makeCtx({ ts: '1717200099.000200', threadTs: '1717200000.000100' });
  assert.equal(buildConversationId(ctx), 'slack-thread-T06P-C123-1717200000.000100');
});

test('buildConversationId: DM ignores thread_ts', () => {
  const ctx = makeCtx({ isDm: true, channelId: 'D08X', threadTs: '1717200000.000100' });
  assert.equal(buildConversationId(ctx), 'slack-im-T06P-D08X');
});

// --- replyThreadTs ---

test('replyThreadTs: returns thread_ts when present', () => {
  const ctx = makeCtx({ threadTs: '1717200000.000100' });
  assert.equal(replyThreadTs(ctx), '1717200000.000100');
});

test('replyThreadTs: falls back to ts', () => {
  const ctx = makeCtx({ ts: '1717200099.000200', threadTs: undefined });
  assert.equal(replyThreadTs(ctx), '1717200099.000200');
});

// --- stripBotMention ---

test('stripBotMention: removes bot mention from text', () => {
  assert.equal(stripBotMention('<@U0BOT> hello world', 'U0BOT'), 'hello world');
});

test('stripBotMention: handles multiple mentions', () => {
  assert.equal(stripBotMention('<@U0BOT> hi <@U0BOT>', 'U0BOT'), 'hi');
});

test('stripBotMention: returns text unchanged if no mention', () => {
  assert.equal(stripBotMention('hello world', 'U0BOT'), 'hello world');
});

test('stripBotMention: returns empty string for mention-only text', () => {
  assert.equal(stripBotMention('<@U0BOT>', 'U0BOT'), '');
});

// --- checkAccess ---

test('checkAccess: allowed with no restrictions', () => {
  assert.equal(checkAccess(makeCtx(), makeConfig()), 'allowed');
});

test('checkAccess: DMs pass even when team/channel restricted', () => {
  const ctx = makeCtx({ isDm: true });
  const cfg = makeConfig({
    allowedTeamIds: new Set(['OTHER']),
    allowedChannelIds: new Set(['OTHER']),
  });
  assert.equal(checkAccess(ctx, cfg), 'allowed');
});

test('checkAccess: allowlisted user is allowed', () => {
  const ctx = makeCtx({ userId: 'UGOOD' });
  const cfg = makeConfig({ allowedUserIds: new Set(['UGOOD']) });
  assert.equal(checkAccess(ctx, cfg), 'allowed');
});

test('checkAccess: non-allowlisted user is guest (rate-limited)', () => {
  const ctx = makeCtx({ userId: 'UBAD' });
  const cfg = makeConfig({ allowedUserIds: new Set(['UGOOD']) });
  assert.equal(checkAccess(ctx, cfg), 'guest');
});

test('checkAccess: DM non-allowlisted user is also guest', () => {
  const ctx = makeCtx({ isDm: true, userId: 'UBAD' });
  const cfg = makeConfig({ allowedUserIds: new Set(['UGOOD']) });
  assert.equal(checkAccess(ctx, cfg), 'guest');
});

test('checkAccess: denied for wrong team', () => {
  const ctx = makeCtx({ teamId: 'TWRONG' });
  const cfg = makeConfig({ allowedTeamIds: new Set(['TRIGHT']) });
  assert.equal(checkAccess(ctx, cfg), 'denied');
});

test('checkAccess: denied for wrong channel', () => {
  const ctx = makeCtx({ channelId: 'CWRONG' });
  const cfg = makeConfig({ allowedChannelIds: new Set(['CRIGHT']) });
  assert.equal(checkAccess(ctx, cfg), 'denied');
});

test('checkAccess: allowed when user, team, and channel all match', () => {
  const ctx = makeCtx({ userId: 'U1', teamId: 'T1', channelId: 'C1' });
  const cfg = makeConfig({
    allowedUserIds: new Set(['U1']),
    allowedTeamIds: new Set(['T1']),
    allowedChannelIds: new Set(['C1']),
  });
  assert.equal(checkAccess(ctx, cfg), 'allowed');
});

// --- GuestRateLimiter ---

test('GuestRateLimiter: new user is within limit', () => {
  const f = join(tmpdir(), `smolpaws-test-${Date.now()}.json`);
  const limiter = new GuestRateLimiter(f, 3);
  assert.equal(limiter.isWithinLimit('U1'), true);
  try { unlinkSync(f); } catch {}
});

test('GuestRateLimiter: user exceeds limit after N records', () => {
  const f = join(tmpdir(), `smolpaws-test-${Date.now()}.json`);
  const limiter = new GuestRateLimiter(f, 2);
  limiter.record('U1');
  limiter.record('U1');
  assert.equal(limiter.isWithinLimit('U1'), false);
  try { unlinkSync(f); } catch {}
});

test('GuestRateLimiter: different users have independent limits', () => {
  const f = join(tmpdir(), `smolpaws-test-${Date.now()}.json`);
  const limiter = new GuestRateLimiter(f, 1);
  limiter.record('U1');
  assert.equal(limiter.isWithinLimit('U1'), false);
  assert.equal(limiter.isWithinLimit('U2'), true);
  try { unlinkSync(f); } catch {}
});

// --- MessageDeduplicator ---

test('MessageDeduplicator: first message is not duplicate', () => {
  const d = new MessageDeduplicator();
  assert.equal(d.isDuplicate('a'), false);
});

test('MessageDeduplicator: same message is duplicate', () => {
  const d = new MessageDeduplicator();
  d.isDuplicate('a');
  assert.equal(d.isDuplicate('a'), true);
});

test('MessageDeduplicator: different messages are not duplicates', () => {
  const d = new MessageDeduplicator();
  d.isDuplicate('a');
  assert.equal(d.isDuplicate('b'), false);
});

// --- MentionedThreadTracker ---

test('MentionedThreadTracker: untracked thread is not tracked', () => {
  const t = new MentionedThreadTracker();
  assert.equal(t.isTracked('1717200000.000100'), false);
});

test('MentionedThreadTracker: tracked thread is tracked', () => {
  const t = new MentionedThreadTracker();
  t.track('1717200000.000100');
  assert.equal(t.isTracked('1717200000.000100'), true);
});

test('MentionedThreadTracker: different threads are independent', () => {
  const t = new MentionedThreadTracker();
  t.track('1717200000.000100');
  assert.equal(t.isTracked('1717200000.000100'), true);
  assert.equal(t.isTracked('1717200000.000200'), false);
});

test('MentionedThreadTracker: evicts oldest when exceeding max', () => {
  const t = new MentionedThreadTracker();
  for (let i = 0; i < 1001; i++) {
    t.track(`thread-${i}`);
  }
  // Oldest threads (first ~500) should be evicted
  assert.equal(t.isTracked('thread-0'), false);
  // Newest threads should still be tracked
  assert.equal(t.isTracked('thread-1000'), true);
});

test('MentionedThreadTracker: re-tracking refreshes insertion order', () => {
  const t = new MentionedThreadTracker();
  // Track thread-0 first, then 999 more
  t.track('thread-0');
  for (let i = 1; i <= 999; i++) {
    t.track(`thread-${i}`);
  }
  // Re-track thread-0 to refresh its position to the end
  t.track('thread-0');
  // Now add one more to trigger eviction
  t.track('thread-1000');
  // thread-0 was refreshed — should survive eviction
  assert.equal(t.isTracked('thread-0'), true);
  // thread-1 was oldest after refresh — should be evicted
  assert.equal(t.isTracked('thread-1'), false);
});

// --- formatThreadContext ---

test('formatThreadContext: returns empty string when no prior messages', () => {
  const messages = [{ user: 'U1', text: 'hello', ts: '100.001' }];
  assert.equal(formatThreadContext(messages, '100.001', 'U0BOT'), '');
});

test('formatThreadContext: formats prior messages with user mentions', () => {
  const messages = [
    { user: 'U1', text: 'What is OpenHands?', ts: '100.001' },
    { user: 'U2', text: 'It is an AI agent platform', ts: '100.002' },
    { user: 'U1', text: '@smolpaws can you help?', ts: '100.003' },
  ];
  const result = formatThreadContext(messages, '100.003', 'U0BOT');
  assert.ok(result.startsWith('[Thread context]'));
  assert.ok(result.includes('<@U1>: What is OpenHands?'));
  assert.ok(result.includes('<@U2>: It is an AI agent platform'));
  assert.ok(result.endsWith('[Current message]\n'));
});

test('formatThreadContext: labels bot messages as smolpaws', () => {
  const messages = [
    { user: 'U1', text: 'help me', ts: '100.001' },
    { user: 'U0BOT', text: 'Sure, what do you need?', ts: '100.002' },
    { user: 'U1', text: 'more help', ts: '100.003' },
  ];
  const result = formatThreadContext(messages, '100.003', 'U0BOT');
  assert.ok(result.includes('smolpaws: Sure, what do you need?'));
  assert.ok(!result.includes('<@U0BOT>'));
});

test('formatThreadContext: excludes current and future messages from context', () => {
  const messages = [
    { user: 'U1', text: 'first message', ts: '100.001' },
    { user: 'U1', text: 'current message', ts: '100.002' },
    { user: 'U1', text: 'future message', ts: '100.003' },
  ];
  const result = formatThreadContext(messages, '100.002', 'U0BOT');
  assert.ok(result.includes('first message'));
  assert.ok(!result.includes('current message'));
  assert.ok(!result.includes('future message'));
});

test('formatThreadContext: preserves microsecond ordering without float parsing', () => {
  const messages = [
    { user: 'U1', text: 'earlier', ts: '1717200000.000199' },
    { user: 'U1', text: 'current', ts: '1717200000.000200' },
    { user: 'U1', text: 'later', ts: '1717200000.000201' },
  ];
  const result = formatThreadContext(messages, '1717200000.000200', 'U0BOT');
  assert.ok(result.includes('earlier'));
  assert.ok(!result.includes('current'));
  assert.ok(!result.includes('later'));
});

test('isPriorSlackTs: compares same-second timestamps by full fractional precision', () => {
  assert.equal(isPriorSlackTs('100.9', '100.10'), false);
  assert.equal(isPriorSlackTs('100.000009', '100.000010'), true);
  assert.equal(isPriorSlackTs('1717200000.12345678', '1717200000.1234568'), true);
  assert.equal(isPriorSlackTs('1717200000.1234568', '1717200000.12345678'), false);
});

test('isThreadContextMessageSubtype: keeps conversational subtypes and drops system ones', () => {
  assert.equal(isThreadContextMessageSubtype(undefined), true);
  assert.equal(isThreadContextMessageSubtype('thread_broadcast'), true);
  assert.equal(isThreadContextMessageSubtype('file_share'), true);
  assert.equal(isThreadContextMessageSubtype('me_message'), true);
  assert.equal(isThreadContextMessageSubtype('channel_join'), false);
  assert.equal(isThreadContextMessageSubtype('pinned_item'), false);
  assert.equal(isThreadContextMessageSubtype('tombstone'), false);
});

test('formatThreadContext: leaves non-user identifiers unwrapped', () => {
  const messages = [
    { user: 'github-actions', text: 'CI passed', ts: '100.001' },
    { user: 'B123BOT', text: 'release automation', ts: '100.002' },
    { user: 'U1', text: 'current', ts: '100.003' },
  ];
  const result = formatThreadContext(messages, '100.003', 'U0BOT');
  assert.ok(result.includes('github-actions: CI passed'));
  assert.ok(result.includes('B123BOT: release automation'));
  assert.ok(!result.includes('<@github-actions>'));
  assert.ok(!result.includes('<@B123BOT>'));
});

test('formatThreadContext: rewrites bot mentions in prior text', () => {
  const messages = [
    { user: 'U1', text: '<@U0BOT> can you help?', ts: '100.001' },
    { user: 'U2', text: 'current', ts: '100.002' },
  ];
  const result = formatThreadContext(messages, '100.002', 'U0BOT');
  assert.ok(result.includes('@smolpaws can you help?'));
  assert.ok(!result.includes('<@U0BOT> can you help?'));
});
