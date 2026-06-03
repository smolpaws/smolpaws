import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationId,
  isAllowed,
  MessageDeduplicator,
  replyThreadTs,
  stripBotMention,
  type SlackEventContext,
} from '../slackContext.js';
import type { SlackConfig } from '../config.js';

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

// --- isAllowed ---

test('isAllowed: passes with no restrictions', () => {
  assert.equal(isAllowed(makeCtx(), makeConfig()), true);
});

test('isAllowed: DMs pass even when team/channel restricted', () => {
  const ctx = makeCtx({ isDm: true });
  const cfg = makeConfig({
    allowedTeamIds: new Set(['OTHER']),
    allowedChannelIds: new Set(['OTHER']),
  });
  assert.equal(isAllowed(ctx, cfg), true);
});

test('isAllowed: rejects user not in user allowlist', () => {
  const ctx = makeCtx({ userId: 'UBAD' });
  const cfg = makeConfig({ allowedUserIds: new Set(['UGOOD']) });
  assert.equal(isAllowed(ctx, cfg), false);
});

test('isAllowed: DM also rejects user not in user allowlist', () => {
  const ctx = makeCtx({ isDm: true, userId: 'UBAD' });
  const cfg = makeConfig({ allowedUserIds: new Set(['UGOOD']) });
  assert.equal(isAllowed(ctx, cfg), false);
});

test('isAllowed: rejects channel message from wrong team', () => {
  const ctx = makeCtx({ teamId: 'TWRONG' });
  const cfg = makeConfig({ allowedTeamIds: new Set(['TRIGHT']) });
  assert.equal(isAllowed(ctx, cfg), false);
});

test('isAllowed: rejects channel message from wrong channel', () => {
  const ctx = makeCtx({ channelId: 'CWRONG' });
  const cfg = makeConfig({ allowedChannelIds: new Set(['CRIGHT']) });
  assert.equal(isAllowed(ctx, cfg), false);
});

test('isAllowed: passes when user, team, and channel all match', () => {
  const ctx = makeCtx({ userId: 'U1', teamId: 'T1', channelId: 'C1' });
  const cfg = makeConfig({
    allowedUserIds: new Set(['U1']),
    allowedTeamIds: new Set(['T1']),
    allowedChannelIds: new Set(['C1']),
  });
  assert.equal(isAllowed(ctx, cfg), true);
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
