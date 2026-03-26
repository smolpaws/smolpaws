import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ConversationState,
  EventLog,
  SecretRegistry,
  type LLMClient,
  type LLMStreamChunk,
} from '@smolpaws/agent-sdk';
import {
  createTrackerSummaryHook,
  trackerSummaryInternals,
} from '../runner/trackerSummary.js';

function createFakeLlmClient(text: string): LLMClient {
  return {
    async *streamChat(): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'text', text };
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
}

test('tracker summary hook summarizes task_tracker plan slices, persists cursor, and logs JSONL', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'tracker-summary-'));
  const conversationId = 'local-test-summary';
  const events = new EventLog();
  const state = new ConversationState({ eventLog: events });
  const delivered: string[] = [];

  const hook = createTrackerSummaryHook({
    persistenceRoot,
    getConversationId: () => conversationId,
    secrets: new SecretRegistry(),
    llmClient: createFakeLlmClient('Progress update\n• Did the thing\n• Now moving on'),
    onSummary: async (entry) => {
      delivered.push(entry.summary);
    },
  });

  events.push({
    kind: 'MessageEvent',
    source: 'user',
    llm_message: { role: 'user', content: [{ type: 'text', text: 'Please add the feature.' }] },
  });
  events.push({
    kind: 'ActionEvent',
    source: 'agent',
    thought: [],
    action: { command: 'plan' },
    tool_name: 'task_tracker',
    tool_call_id: 'tool-1',
    tool_call: {
      id: 'tool-1',
      type: 'function',
      function: { name: 'task_tracker', arguments: '{"command":"plan"}' },
    },
    llm_response_id: 'resp-1',
  });
  events.push({
    kind: 'ObservationEvent',
    source: 'environment',
    observation: {
      command: 'plan',
      task_list: [
        { title: 'Inspect code', status: 'done' },
        { title: 'Implement hook', status: 'in_progress' },
      ],
    },
    tool_name: 'task_tracker',
    tool_call_id: 'tool-1',
    action_id: 'action-1',
  });

  const shouldStop = await hook.shouldStop?.({ state, events });
  assert.equal(shouldStop, false);
  assert.deepEqual(delivered, ['Progress update\n• Did the thing\n• Now moving on']);

  assert.deepEqual(
    state.snapshot.values[trackerSummaryInternals.TRACKER_SUMMARY_CURSOR_KEY],
    { nextEventIndex: 3 },
  );

  const logPath = path.join(persistenceRoot, conversationId, trackerSummaryInternals.TRACKER_SUMMARY_LOG_BASENAME);
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.kind, 'task_tracker_plan_summary');
  assert.equal(entry.conversation_id, conversationId);
  assert.match(entry.prompt, /Recent event slice:/);
  assert.match(entry.summary, /Progress update/);

  const secondRun = await hook.shouldStop?.({ state, events });
  assert.equal(secondRun, false);
  assert.equal(delivered.length, 1);

  rmSync(persistenceRoot, { recursive: true, force: true });
});

test('tracker summary hook ignores conversations without a new task_tracker plan milestone', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'tracker-summary-empty-'));
  const events = new EventLog();
  const state = new ConversationState({ eventLog: events });
  const hook = createTrackerSummaryHook({
    persistenceRoot,
    getConversationId: () => 'local-test-empty',
    secrets: new SecretRegistry(),
    llmClient: createFakeLlmClient('unused'),
  });

  events.push({
    kind: 'MessageEvent',
    source: 'user',
    llm_message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });

  const shouldStop = await hook.shouldStop?.({ state, events });
  assert.equal(shouldStop, false);
  assert.equal(state.snapshot.values[trackerSummaryInternals.TRACKER_SUMMARY_CURSOR_KEY], undefined);
  rmSync(persistenceRoot, { recursive: true, force: true });
});

test('tracker summary hook can seed the cursor at current events for restored conversations', async () => {
  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'tracker-summary-seeded-'));
  const events = new EventLog();
  const state = new ConversationState({ eventLog: events });
  const delivered: string[] = [];

  events.push({
    kind: 'MessageEvent',
    source: 'user',
    llm_message: { role: 'user', content: [{ type: 'text', text: 'old message' }] },
  });
  events.push({
    kind: 'ObservationEvent',
    source: 'environment',
    observation: { command: 'plan', task_list: [{ title: 'old task', status: 'done' }] },
    tool_name: 'task_tracker',
    tool_call_id: 'old-tool',
    action_id: 'old-action',
  });

  const hook = createTrackerSummaryHook({
    persistenceRoot,
    getConversationId: () => 'local-test-seeded',
    secrets: new SecretRegistry(),
    llmClient: createFakeLlmClient('Restored summary'),
    onSummary: async (entry) => {
      delivered.push(entry.summary);
    },
    seedCursorAtCurrentEvents: true,
  });

  const firstRun = await hook.shouldStop?.({ state, events });
  assert.equal(firstRun, false);
  assert.deepEqual(delivered, []);

  events.push({
    kind: 'ObservationEvent',
    source: 'environment',
    observation: { command: 'plan', task_list: [{ title: 'new task', status: 'in_progress' }] },
    tool_name: 'task_tracker',
    tool_call_id: 'new-tool',
    action_id: 'new-action',
  });

  const secondRun = await hook.shouldStop?.({ state, events });
  assert.equal(secondRun, false);
  assert.deepEqual(delivered, ['Restored summary']);
  const cursor = state.snapshot.values[trackerSummaryInternals.TRACKER_SUMMARY_CURSOR_KEY] as { nextEventIndex: number };
  assert.equal(cursor.nextEventIndex, 4);
  rmSync(persistenceRoot, { recursive: true, force: true });
});
