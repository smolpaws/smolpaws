import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { Logger } from 'pino';

import type { SlackConfig } from '../config.js';
import { handleSlackEvent, type SlackDeps } from '../slackHandler.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  type SlackEventContext,
} from '../slackContext.js';

function noopLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, fatal: noop } as unknown as Logger;
}

function config(): SlackConfig {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    allowedTeamIds: new Set(),
    allowedChannelIds: new Set(),
    allowedUserIds: new Set(),
    logLevel: 'silent',
  };
}

function context(): SlackEventContext {
  return {
    teamId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    ts: '100.001',
    text: '<@UBOT> durable hello',
    isDm: false,
    botUserId: 'UBOT',
  };
}

function dependencies(dispatch: SlackDeps['dispatch']) {
  const posts: string[] = [];
  const deps: SlackDeps = {
    config: config(),
    dedup: new MessageDeduplicator(),
    guestLimiter: new GuestRateLimiter(
      join(tmpdir(), `slack-durable-dedup-${process.pid}-${Date.now()}.json`),
    ),
    mentionedThreads: new MentionedThreadTracker(),
    logger: noopLogger(),
    postMessage: async (_channel, text) => {
      posts.push(text);
    },
    addReaction: async () => undefined,
    dispatch,
  };
  return { deps, posts };
}

test('a failed durable acceptance releases the Slack event for retry', async () => {
  let dispatches = 0;
  const { deps, posts } = dependencies(async () => {
    dispatches += 1;
    if (dispatches === 1) throw new Error('agent-server temporarily unavailable');
  });
  const ctx = context();

  await handleSlackEvent(ctx, deps); // fails before durable intake exists
  await handleSlackEvent(ctx, deps); // Slack retry must be accepted
  await handleSlackEvent(ctx, deps); // accepted event is now a duplicate

  assert.equal(dispatches, 2);
  assert.equal(posts.filter((text) => text.includes('Something went wrong')).length, 1);
  assert.equal(deps.mentionedThreads.isTracked(ctx.ts), true);
});

test('an in-flight Slack acceptance suppresses a concurrent duplicate', async () => {
  let dispatches = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { deps } = dependencies(async () => {
    dispatches += 1;
    await gate;
  });
  const ctx = context();

  const first = handleSlackEvent(ctx, deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handleSlackEvent(ctx, deps);
  assert.equal(dispatches, 1);

  release();
  await first;
  await handleSlackEvent(ctx, deps);
  assert.equal(dispatches, 1);
});
