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

test('buildHeartbeatConversationId is a stable per-day UUID (daily reuse on the new server)', () => {
  const id = buildHeartbeatConversationId(new Date('2026-03-24T15:16:00'));
  // Valid UUID, and identical for any time on the same local day.
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, buildHeartbeatConversationId(new Date('2026-03-24T23:59:00')));
  // A different local day yields a different id.
  assert.notEqual(id, buildHeartbeatConversationId(new Date('2026-03-25T00:01:00')));
  assert.equal(DEFAULT_HEARTBEAT_CRON, '0 * * * *');
});

test('buildHeartbeatRequest targets the new profile-first server without outbound messaging', () => {
  process.env.SMOLPAWS_DEFAULT_WORKING_DIR = 'smolpaws';
  delete process.env.SMOLPAWS_HEARTBEAT_PROFILE;
  const request = buildHeartbeatRequest(new Date('2026-03-24T15:16:00'));

  assert.equal(request.conversation_id, buildHeartbeatConversationId(new Date('2026-03-24T15:16:00')));
  assert.equal(request.agent.agent_kind, 'openhands');
  assert.equal(request.agent.llm_profile_ref, 'deepseek-v4-pro');
  assert.equal(request.workspace.kind, 'LocalWorkspace');
  assert.equal(request.workspace.working_dir, 'smolpaws');
  assert.equal(request.max_iterations, 500);
  assert.equal(request.initial_message.role, 'user');
  assert.match(request.initial_message.content, /Carry out the heartbeat checklist quietly\./);
  assert.match(request.initial_message.content, /Do not send outbound messages\./);
});

test('buildHeartbeatRequest honors SMOLPAWS_HEARTBEAT_PROFILE override', () => {
  process.env.SMOLPAWS_HEARTBEAT_PROFILE = 'some-other-profile';
  try {
    const request = buildHeartbeatRequest(new Date('2026-03-24T15:16:00'));
    assert.equal(request.agent.llm_profile_ref, 'some-other-profile');
  } finally {
    delete process.env.SMOLPAWS_HEARTBEAT_PROFILE;
  }
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
