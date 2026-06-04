import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import { handleSlackEvent, splitMessage, type SlackDeps } from '../slackHandler.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  type SlackEventContext,
} from '../slackContext.js';
import type { SlackConfig } from '../config.js';
import type { DispatchResult } from '../agentServerClient.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function noopLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, fatal: noop } as unknown as Logger;
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

function makeCtx(overrides: Partial<SlackEventContext> = {}): SlackEventContext {
  return {
    teamId: 'T06P',
    channelId: 'C123',
    userId: 'U456',
    ts: '1717200000.000100',
    text: '<@U0BOT> help me with this',
    isDm: false,
    botUserId: 'U0BOT',
    ...overrides,
  };
}

type PostedMessage = { channel: string; text: string; threadTs: string };
type AddedReaction = { channel: string; timestamp: string; name: string };
type DispatchCall = { conversationId: string; prompt: string; messageId: string };

function makeDeps(overrides: Partial<SlackDeps> = {}): SlackDeps & {
  posted: PostedMessage[];
  reactions: AddedReaction[];
  dispatched: DispatchCall[];
} {
  const posted: PostedMessage[] = [];
  const reactions: AddedReaction[] = [];
  const dispatched: DispatchCall[] = [];

  return {
    config: makeConfig(),
    dedup: new MessageDeduplicator(),
    guestLimiter: new GuestRateLimiter(join(tmpdir(), `smolpaws-test-${Date.now()}-${Math.random()}.json`), 5),
    mentionedThreads: new MentionedThreadTracker(),
    logger: noopLogger(),
    postMessage: async (channel, text, threadTs) => { posted.push({ channel, text, threadTs }); },
    addReaction: async (channel, timestamp, name) => { reactions.push({ channel, timestamp, name }); },
    dispatch: async (opts) => {
      dispatched.push({ conversationId: opts.conversationId, prompt: opts.prompt, messageId: opts.messageId });
      return { reply: `Reply to: ${opts.prompt}`, outboundMessages: [], conversationId: opts.conversationId };
    },
    posted,
    reactions,
    dispatched,
    ...overrides,
  };
}

// ── DM round-trip ──

test('DM: dispatches to agent and posts reply in DM', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ isDm: true, channelId: 'D08X', text: 'hello paws' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].conversationId, 'slack-im-T06P-D08X');
  assert.equal(deps.dispatched[0].prompt, 'hello paws');
  assert.equal(deps.posted.length, 1);
  assert.equal(deps.posted[0].text, 'Reply to: hello paws');
  assert.equal(deps.posted[0].channel, 'D08X');
});

test('DM: shows DM-specific help for empty prompt', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ isDm: true, channelId: 'D08X', text: '' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 0);
  assert.equal(deps.posted.length, 1);
  assert.ok(deps.posted[0].text.includes('Send me a message'));
});

// ── app_mention round-trip ──

test('app_mention: dispatches with thread conversation ID and posts reply', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ text: '<@U0BOT> explain this code' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].conversationId, 'slack-thread-T06P-C123-1717200000.000100');
  assert.equal(deps.dispatched[0].prompt, 'explain this code');
  assert.equal(deps.posted.length, 1);
  assert.equal(deps.posted[0].threadTs, '1717200000.000100');
});

test('app_mention: shows channel-specific help for mention-only message', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ text: '<@U0BOT>' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 0);
  assert.equal(deps.posted.length, 1);
  assert.ok(deps.posted[0].text.includes('after the mention'));
});

test('app_mention: tracks thread for follow-ups', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ text: '<@U0BOT> start working', ts: '1717200000.000100' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.mentionedThreads.isTracked('1717200000.000100'), true);
});

test('app_mention: threaded reply uses thread_ts as root', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({
    text: '<@U0BOT> follow up',
    ts: '1717200099.000200',
    threadTs: '1717200000.000100',
  });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched[0].conversationId, 'slack-thread-T06P-C123-1717200000.000100');
  assert.equal(deps.posted[0].threadTs, '1717200000.000100');
});

// ── Thread follow-ups ──

test('thread follow-up: responds without mention in tracked thread', async () => {
  const deps = makeDeps();

  // First: mention in a thread
  const mention = makeCtx({ text: '<@U0BOT> hey', ts: '1717200000.000100' });
  await handleSlackEvent(mention, deps);
  assert.equal(deps.dispatched.length, 1);

  // Second: follow-up in the same thread WITHOUT mention
  const followUp = makeCtx({
    text: 'what about this part?',
    ts: '1717200099.000200',
    threadTs: '1717200000.000100',
  });
  await handleSlackEvent(followUp, deps);

  assert.equal(deps.dispatched.length, 2);
  assert.equal(deps.dispatched[1].prompt, 'what about this part?');
  assert.equal(deps.dispatched[1].conversationId, 'slack-thread-T06P-C123-1717200000.000100');
});

test('thread follow-up: does NOT track DM threads', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ isDm: true, channelId: 'D08X', text: 'hello', ts: '1717200000.000100' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.mentionedThreads.isTracked('1717200000.000100'), false);
});

// ── Dedup ──

test('dedup: second identical event is silently ignored', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ text: '<@U0BOT> do something' });

  await handleSlackEvent(ctx, deps);
  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.posted.length, 1);
});

// ── Access control ──

test('access: denied user gets no response', async () => {
  const deps = makeDeps({
    config: makeConfig({ allowedTeamIds: new Set(['TOTHER']) }),
  });
  const ctx = makeCtx({ teamId: 'TWRONG', text: '<@U0BOT> hello' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 0);
  assert.equal(deps.posted.length, 0);
});

test('access: guest user gets rate-limited after 2 conversations', async () => {
  const f = join(tmpdir(), `smolpaws-e2e-${Date.now()}.json`);
  try {
    const deps = makeDeps({
      config: makeConfig({ allowedUserIds: new Set(['UGOOD']) }),
      guestLimiter: new GuestRateLimiter(f, 2),
    });

    const ctx1 = makeCtx({ userId: 'UGUEST', text: '<@U0BOT> q1', ts: '100.001' });
    const ctx2 = makeCtx({ userId: 'UGUEST', text: '<@U0BOT> q2', ts: '100.002' });
    const ctx3 = makeCtx({ userId: 'UGUEST', text: '<@U0BOT> q3', ts: '100.003' });

    await handleSlackEvent(ctx1, deps);
    await handleSlackEvent(ctx2, deps);
    await handleSlackEvent(ctx3, deps);

    assert.equal(deps.dispatched.length, 2);
    const rateLimitMsg = deps.posted.find(p => p.text.includes('guest conversations'));
    assert.ok(rateLimitMsg);
  } finally {
    try { unlinkSync(f); } catch {}
  }
});

test('access: allowlisted user is never rate-limited', async () => {
  const deps = makeDeps({
    config: makeConfig({ allowedUserIds: new Set(['U456']) }),
  });

  for (let i = 0; i < 10; i++) {
    const ctx = makeCtx({ text: `<@U0BOT> msg ${i}`, ts: `100.${i.toString().padStart(3, '0')}` });
    await handleSlackEvent(ctx, deps);
  }

  assert.equal(deps.dispatched.length, 10);
});

// ── Eyes reaction ──

test('eyes reaction: added on accepted messages', async () => {
  const deps = makeDeps();
  const ctx = makeCtx({ text: '<@U0BOT> do stuff' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.reactions.length, 1);
  assert.equal(deps.reactions[0].name, 'eyes');
  assert.equal(deps.reactions[0].timestamp, '1717200000.000100');
});

test('eyes reaction: NOT added for denied users', async () => {
  const deps = makeDeps({
    config: makeConfig({ allowedTeamIds: new Set(['TOTHER']) }),
  });
  const ctx = makeCtx({ text: '<@U0BOT> hello' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.reactions.length, 0);
});

// ── Outbound messages ──

test('outbound: delivers outbound messages before final reply', async () => {
  const deps = makeDeps({
    dispatch: async (opts) => ({
      reply: 'final answer',
      outboundMessages: [
        { kind: 'current_thread_message', text: 'progress 1' },
        { kind: 'current_thread_message', text: 'progress 2' },
      ],
      conversationId: opts.conversationId,
    }),
  });
  const ctx = makeCtx({ text: '<@U0BOT> do complex thing' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.posted.length, 3);
  assert.equal(deps.posted[0].text, 'progress 1');
  assert.equal(deps.posted[1].text, 'progress 2');
  assert.equal(deps.posted[2].text, 'final answer');
});

// ── Error handling ──

test('error: dispatch failure sends error message to Slack', async () => {
  const deps = makeDeps({
    dispatch: async () => { throw new Error('agent server down'); },
  });
  const ctx = makeCtx({ text: '<@U0BOT> do something' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.posted.length, 1);
  assert.ok(deps.posted[0].text.includes('Something went wrong'));
});

// ── Thread context ──

test('thread context: prepends prior messages to prompt when in a thread', async () => {
  const deps = makeDeps({
    fetchThreadMessages: async () => [
      { user: 'U1', text: 'What is OpenHands?', ts: '1717200000.000100' },
      { user: 'U2', text: 'An AI agent platform', ts: '1717200000.000150' },
      { user: 'U456', text: '<@U0BOT> can you explain more?', ts: '1717200000.000200' },
    ],
  });
  const ctx = makeCtx({
    text: '<@U0BOT> can you explain more?',
    ts: '1717200000.000200',
    threadTs: '1717200000.000100',
  });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.ok(deps.dispatched[0].prompt.includes('[Thread context]'));
  assert.ok(deps.dispatched[0].prompt.includes('<@U1>: What is OpenHands?'));
  assert.ok(deps.dispatched[0].prompt.includes('<@U2>: An AI agent platform'));
  const threadContextEnd = deps.dispatched[0].prompt.indexOf('[Current message]');
  const threadContext = deps.dispatched[0].prompt.slice(0, threadContextEnd);
  assert.ok(!threadContext.includes('<@U456>: can you explain more?'));
  assert.ok(deps.dispatched[0].prompt.includes('[Current message]'));
  assert.ok(deps.dispatched[0].prompt.endsWith('can you explain more?'));
});

test('thread context: not fetched for non-threaded messages', async () => {
  let fetchCalled = false;
  const deps = makeDeps({
    fetchThreadMessages: async () => { fetchCalled = true; return []; },
  });
  const ctx = makeCtx({ text: '<@U0BOT> hello', threadTs: undefined });

  await handleSlackEvent(ctx, deps);

  assert.equal(fetchCalled, false);
  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].prompt, 'hello');
});

test('thread context: labels bot messages as smolpaws', async () => {
  const deps = makeDeps({
    fetchThreadMessages: async () => [
      { user: 'U1', text: 'help', ts: '100.001' },
      { user: 'U0BOT', text: 'Sure thing', ts: '100.002' },
      { user: 'U1', text: '<@U0BOT> more help', ts: '100.003' },
    ],
  });
  const ctx = makeCtx({ text: '<@U0BOT> more help', ts: '100.003', threadTs: '100.001' });

  await handleSlackEvent(ctx, deps);

  assert.ok(deps.dispatched[0].prompt.includes('smolpaws: Sure thing'));
});

test('thread context: leaves non-user identifiers unwrapped', async () => {
  const deps = makeDeps({
    fetchThreadMessages: async () => [
      { user: 'github-actions', text: 'CI passed', ts: '100.001' },
      { user: 'B123BOT', text: '<@U0BOT> release automation', ts: '100.002' },
      { user: 'U1', text: '<@U0BOT> more help', ts: '100.003' },
    ],
  });
  const ctx = makeCtx({ text: '<@U0BOT> more help', ts: '100.003', threadTs: '100.001' });

  await handleSlackEvent(ctx, deps);

  assert.ok(deps.dispatched[0].prompt.includes('github-actions: CI passed'));
  assert.ok(deps.dispatched[0].prompt.includes('B123BOT: @smolpaws release automation'));
  assert.ok(!deps.dispatched[0].prompt.includes('<@github-actions>'));
  assert.ok(!deps.dispatched[0].prompt.includes('<@B123BOT>'));
  assert.ok(!deps.dispatched[0].prompt.includes('<@U0BOT> release automation'));
});

test('thread context: gracefully degrades on fetch failure', async () => {
  const deps = makeDeps({
    fetchThreadMessages: async () => { throw new Error('API error'); },
  });
  const ctx = makeCtx({ text: '<@U0BOT> help me', ts: '100.002', threadTs: '100.001' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].prompt, 'help me');
});

test('thread context: works without fetchThreadMessages dependency', async () => {
  const deps = makeDeps();
  // deps.fetchThreadMessages is undefined by default
  const ctx = makeCtx({ text: '<@U0BOT> hello', ts: '100.002', threadTs: '100.001' });

  await handleSlackEvent(ctx, deps);

  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].prompt, 'hello');
});

test('thread context: not fetched when thread_ts matches current message ts', async () => {
  let fetchCalled = false;
  const deps = makeDeps({
    fetchThreadMessages: async () => {
      fetchCalled = true;
      return [];
    },
  });
  const ctx = makeCtx({ text: '<@U0BOT> hello', ts: '100.002', threadTs: '100.002' });

  await handleSlackEvent(ctx, deps);

  assert.equal(fetchCalled, false);
  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].prompt, 'hello');
});

// ── splitMessage ──

test('splitMessage: short text returns single chunk', () => {
  const chunks = splitMessage('hello world');
  assert.deepEqual(chunks, ['hello world']);
});

test('splitMessage: long text splits at newlines', () => {
  const line = 'x'.repeat(2000);
  const text = `${line}\n${line}\n${line}`;
  const chunks = splitMessage(text);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 5900);
  }
});

test('splitMessage: preserves earlier newline when no space improves on it', () => {
  // 4000 chars of no-space text, a newline, then 3000 more chars of no-space text
  // The newline at 4000 is > 30% of 5900 (1770), so it should be used
  const before = 'a'.repeat(4000);
  const after = 'b'.repeat(3000);
  const text = `${before}\n${after}`;
  const chunks = splitMessage(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], before);
});
