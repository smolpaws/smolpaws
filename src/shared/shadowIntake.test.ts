/**
 * Shadow-intake tests (ADR step 3). Real coordinator + store where feasible; the only fakes are the
 * injected boundaries (a recording coordinator to assert lane/message, and a throwing HTTP client to
 * prove errors never propagate).
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';

import { MessageRelay } from '../coordinator/messageRelay.js';
import { MessageWorkStore } from '../coordinator/store.js';
import { DEFAULT_RETRY_POLICY, type AgentServerClient, type InboundMessage, type IntegrationOutcome, type LaneDescriptor, type WorkRow } from '../coordinator/types.js';
import type { IncomingMessage } from './bridgeAdapter.js';
import {
  ShadowIntake,
  __resetShadowForTests,
  __setShadowCoordinatorFactoryForTests,
  getSharedShadowIntake,
  isShadowEnabled,
  slackLaneDescriptor,
  type ShadowCoordinator,
} from './shadowIntake.js';

const logger = pino({ level: 'silent' });

function withFlag(value: string | undefined, fn: () => void | Promise<void>): void | Promise<void> {
  const prev = process.env.SMOLPAWS_COORD_SHADOW;
  if (value === undefined) delete process.env.SMOLPAWS_COORD_SHADOW;
  else process.env.SMOLPAWS_COORD_SHADOW = value;
  __resetShadowForTests();
  const restore = () => {
    if (prev === undefined) delete process.env.SMOLPAWS_COORD_SHADOW;
    else process.env.SMOLPAWS_COORD_SHADOW = prev;
    __resetShadowForTests();
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

const threadMsg: IncomingMessage = {
  conversationId: 'slack-thread-T1-C1-1700000000.100',
  prompt: 'hello from a thread',
  messageId: 'C1:1700000000.200',
  platformContext: { team_id: 'T1', channel_id: 'C1', thread_ts: '1700000000.100' },
};

const dmMsg: IncomingMessage = {
  conversationId: 'slack-im-T1-D9',
  prompt: 'hi in a DM',
  messageId: 'D9:1700000000.300',
  // In a DM, thread_ts is the per-message ts — the lane must still collapse to :root.
  platformContext: { team_id: 'T1', channel_id: 'D9', thread_ts: '1700000000.300' },
};

// ── lane derivation (pure) ──────────────────────────────────────────────────────────────────────

test('slackLaneDescriptor: a thread maps to a stable per-root lane', () => {
  assert.deepEqual(slackLaneDescriptor(threadMsg), {
    laneKey: 'channel:slack:T1:C1:1700000000.100',
    platform: 'slack',
    accountId: 'T1',
    chatId: 'C1',
    threadId: '1700000000.100',
    displayName: 'slack-thread-T1-C1-1700000000.100',
  });
});

test('slackLaneDescriptor: a DM collapses to one :root lane (not per-message)', () => {
  const a = slackLaneDescriptor(dmMsg);
  const b = slackLaneDescriptor({ ...dmMsg, messageId: 'D9:1700000000.999', platformContext: { team_id: 'T1', channel_id: 'D9', thread_ts: '1700000000.999' } });
  assert.equal(a?.laneKey, 'channel:slack:T1:D9:root');
  assert.equal(a?.threadId, null);
  assert.equal(a?.laneKey, b?.laneKey, 'two DM messages share one lane');
});

test('slackLaneDescriptor: missing team/channel → null (shadow safely skips)', () => {
  assert.equal(slackLaneDescriptor({ ...threadMsg, platformContext: {} }), null);
  assert.equal(slackLaneDescriptor({ ...threadMsg, platformContext: undefined }), null);
});

// ── flag gate ───────────────────────────────────────────────────────────────────────────────────

test('isShadowEnabled: only when flag=1 AND channel is slack', () => {
  withFlag(undefined, () => assert.equal(isShadowEnabled('slack'), false));
  withFlag('1', () => {
    assert.equal(isShadowEnabled('slack'), true);
    assert.equal(isShadowEnabled('discord'), false); // allowlist: slack only
    assert.equal(isShadowEnabled('whatsapp'), false);
  });
  withFlag('0', () => assert.equal(isShadowEnabled('slack'), false));
});

test('flag OFF: the coordinator is never constructed', () => {
  let built = 0;
  withFlag(undefined, () => {
    // Set the factory INSIDE the flag scope (withFlag resets overrides on entry).
    __setShadowCoordinatorFactoryForTests(() => {
      built += 1;
      return new RecordingCoordinator();
    });
    assert.equal(getSharedShadowIntake(logger), null, 'no shadow instance when off');
    assert.equal(built, 0, 'factory never invoked when off');
  });
});

// ── flag ON: forwards the right lane + message ────────────────────────────────────────────────────

test('flag ON: accept() forwards the right lane + message to the coordinator', async () => {
  const recording = new RecordingCoordinator();
  await withFlag('1', async () => {
    __setShadowCoordinatorFactoryForTests(() => recording); // inside the flag scope
    const shadow = getSharedShadowIntake(logger);
    assert.ok(shadow, 'shadow instance built when on');
    await shadow.accept(threadMsg);
    assert.equal(recording.accepted.length, 1);
    assert.equal(recording.accepted[0].descriptor.laneKey, 'channel:slack:T1:C1:1700000000.100');
    assert.deepEqual(recording.accepted[0].message, { sourceMessageId: 'C1:1700000000.200', content: 'hello from a thread' });
    assert.equal(recording.integrated, 1, 'intake is integrated (append + run) after accept');
  });
});

test('accept() skips a message with no messageId, without calling the coordinator', async () => {
  const recording = new RecordingCoordinator();
  const shadow = new ShadowIntake(recording, logger);
  await shadow.accept({ ...threadMsg, messageId: undefined });
  assert.equal(recording.accepted.length, 0);
});

// ── error isolation: a real coordinator with a throwing HTTP client must not propagate ───────────

test('a coordinator/server error is swallowed — accept() resolves and never throws', async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'shadow-err-')), 'c.db');
  const store = new MessageWorkStore(new Database(dbPath), DEFAULT_RETRY_POLICY);
  const throwingClient: AgentServerClient = {
    ensureConversation: async () => {
      throw new Error('new server is down');
    },
    appendEvent: async () => {
      throw new Error('new server is down');
    },
    searchEvents: async () => {
      throw new Error('new server is down');
    },
  };
  const coordinator = new MessageRelay(store, throwingClient);
  const shadow = new ShadowIntake(coordinator, logger);

  // Must resolve (no throw, no rejection) even though the real coordinator hits a dead server.
  await assert.doesNotReject(() => shadow.accept(threadMsg));
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

class RecordingCoordinator implements ShadowCoordinator {
  accepted: Array<{ descriptor: LaneDescriptor; message: InboundMessage }> = [];
  integrated = 0;

  async acceptInbound(descriptor: LaneDescriptor, message: InboundMessage): Promise<WorkRow> {
    this.accepted.push({ descriptor, message });
    return { id: `work-${this.accepted.length}` } as unknown as WorkRow;
  }

  async integrateNextIntake(_worker: string): Promise<IntegrationOutcome> {
    this.integrated += 1;
    return { kind: 'integrated', workId: 'work-1', eventCreated: true };
  }
}
