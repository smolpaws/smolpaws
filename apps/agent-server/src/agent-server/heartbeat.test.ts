import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildHeartbeatConversationId,
  buildHeartbeatPaths,
  buildHeartbeatPrompt,
  buildHeartbeatRequest,
  DEFAULT_HEARTBEAT_RUNNER_HOST,
  DEFAULT_HEARTBEAT_RUNNER_PORT,
  resolveHeartbeatRunnerBaseUrl,
} from './heartbeat.js';

test('buildHeartbeatConversationId creates a unique conversation per heartbeat run', () => {
  assert.equal(
    buildHeartbeatConversationId(new Date('2026-03-24T15:16:00')),
    'heartbeat-smolpaws-2026-03-24-15-16-00',
  );
});

test('buildHeartbeatRequest uses the canonical conversation path without outbound messaging', () => {
  process.env.SMOLPAWS_DEFAULT_WORKING_DIR = 'smolpaws';
  const request = buildHeartbeatRequest(new Date('2026-03-24T15:16:00'));
  const initialText = request.initial_message?.content?.[0];

  assert.equal(request.conversation_id, 'heartbeat-smolpaws-2026-03-24-15-16-00');
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
  try {
    delete process.env.SMOLPAWS_HOME_DIR;
    const paths = buildHeartbeatPaths('/Users/enyst');
    const prompt = buildHeartbeatPrompt(paths, new Date('2026-03-24T15:16:00'));

    assert.match(prompt, /\/Users\/enyst\/repos\/smolpaws\/docs\/smolpaws/);
    assert.match(prompt, /\/Users\/enyst\/\.smolpaws\/memory/);
    assert.match(prompt, /MEMORY\.md/);
    assert.match(prompt, /heartbeat-state\.json/);
    assert.match(prompt, /Do not send outbound messages\./);
  } finally {
    if (previousSmolpawsHomeDir) {
      process.env.SMOLPAWS_HOME_DIR = previousSmolpawsHomeDir;
    } else {
      delete process.env.SMOLPAWS_HOME_DIR;
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
