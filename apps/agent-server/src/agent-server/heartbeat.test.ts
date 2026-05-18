import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_HEARTBEAT_CRON,
  buildHeartbeatConversationId,
  buildHeartbeatPaths,
  buildHeartbeatPrompt,
  buildHeartbeatRequest,
  DEFAULT_HEARTBEAT_RUNNER_HOST,
  DEFAULT_HEARTBEAT_RUNNER_PORT,
  resolveHeartbeatRunnerBaseUrl,
} from './heartbeat.js';

test('buildHeartbeatConversationId creates one conversation per local day', () => {
  assert.equal(
    buildHeartbeatConversationId(new Date('2026-03-24T15:16:00')),
    'heartbeat-smolpaws-2026-03-24',
  );
  assert.equal(DEFAULT_HEARTBEAT_CRON, '0 * * * *');
});

test('buildHeartbeatRequest uses the canonical conversation path without outbound messaging', () => {
  process.env.SMOLPAWS_DEFAULT_WORKING_DIR = 'smolpaws';
  const request = buildHeartbeatRequest(new Date('2026-03-24T15:16:00'));
  const initialText = request.initial_message?.content?.[0];

  assert.equal(request.conversation_id, 'heartbeat-smolpaws-2026-03-24');
  assert.equal(request.workspace?.working_dir, 'smolpaws');
  assert.equal(request.max_iterations, 500);
  assert.equal(request.smolpaws?.ingress, 'heartbeat');
  assert.equal(request.smolpaws?.enable_send_message, false);
  assert.equal(request.smolpaws?.enable_task_tools, false);
  assert.equal(initialText?.type, 'text');
  assert.match((initialText as { text: string }).text, /Carry out the heartbeat checklist quietly\./);
});

test('buildHeartbeatPrompt points the agent at the canonical docs and state files', () => {
  const previousSmolpawsHomeDir = process.env.SMOLPAWS_HOME_DIR;
  const previousConversationsDir = process.env.SMOLPAWS_CONVERSATIONS_DIR;
  try {
    delete process.env.SMOLPAWS_HOME_DIR;
    delete process.env.SMOLPAWS_CONVERSATIONS_DIR;
    const paths = buildHeartbeatPaths('/Users/enyst');
    const prompt = buildHeartbeatPrompt(paths, new Date('2026-03-24T15:16:00'));

    assert.match(prompt, /\/Users\/enyst\/repos\/smolpaws\/docs\/smolpaws/);
    assert.match(prompt, /\/Users\/enyst\/\.smolpaws\/memory/);
    assert.match(prompt, /\/Users\/enyst\/\.openhands\/conversations/);
    assert.match(prompt, /Conversation archive directory:/);
    assert.match(prompt, /MEMORY\.md/);
    assert.match(prompt, /heartbeat-state\.json/);
    assert.match(prompt, /do not silently narrow the required channel set/i);
    assert.match(prompt, /success-stories \(C07KHERRM2S\)/);
    assert.match(prompt, /proj-agent \(C06R25BT5B2\)/);
    assert.match(prompt, /Do not send outbound messages\./);
  } finally {
    if (previousSmolpawsHomeDir) {
      process.env.SMOLPAWS_HOME_DIR = previousSmolpawsHomeDir;
    } else {
      delete process.env.SMOLPAWS_HOME_DIR;
    }
    if (previousConversationsDir) {
      process.env.SMOLPAWS_CONVERSATIONS_DIR = previousConversationsDir;
    } else {
      delete process.env.SMOLPAWS_CONVERSATIONS_DIR;
    }
  }
});

test('buildHeartbeatPaths honors an explicit conversation archive override', () => {
  const previousConversationsDir = process.env.SMOLPAWS_CONVERSATIONS_DIR;
  try {
    process.env.SMOLPAWS_CONVERSATIONS_DIR = '/tmp/smolpaws-heartbeats';
    const paths = buildHeartbeatPaths('/Users/enyst');
    assert.equal(paths.conversationArchiveDir, '/tmp/smolpaws-heartbeats');
  } finally {
    if (previousConversationsDir) {
      process.env.SMOLPAWS_CONVERSATIONS_DIR = previousConversationsDir;
    } else {
      delete process.env.SMOLPAWS_CONVERSATIONS_DIR;
    }
  }
});

test('resolveHeartbeatRunnerBaseUrl prefers explicit runner url and otherwise uses local defaults', () => {
  assert.equal(
    resolveHeartbeatRunnerBaseUrl({ SMOLPAWS_RUNNER_URL: 'https://runner.example.com/' } as NodeJS.ProcessEnv),
    'https://runner.example.com',
  );
  assert.equal(
    resolveHeartbeatRunnerBaseUrl({} as NodeJS.ProcessEnv),
    `http://${DEFAULT_HEARTBEAT_RUNNER_HOST}:${DEFAULT_HEARTBEAT_RUNNER_PORT}`,
  );
});
