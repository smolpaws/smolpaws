import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ConversationState, InMemorySecretStore, actionEventsFromMessage, agentErrorEventSchema, conversationErrorEventSchema,
  createLlmUsageEvent, llmProfileSchema, llmProviderSecretRef, messageEventSchema,
  messageSchema, observationEventSchema, userRejectObservationSchema, type Event,
} from '@smolpaws/openhands-agent';
import { expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp } from '../app.js';
import { leaseFileName } from '../conversationLease.js';
import { ConversationService } from '../conversationService.js';
import { startConversationRequestSchema } from '../models.js';

interface ChatMessage {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: readonly { readonly id: string }[];
  readonly tool_call_id?: string;
}

async function info(server: AgentServerApp, id: string) {
  const response = await server.app.inject(`/api/conversations/${id}`);
  expect(response.statusCode).toBe(200);
  return response.json<{
    execution_status: string;
    stats: unknown;
    metrics: { accumulated_token_usage: { prompt_tokens: number; completion_tokens: number } };
  }>();
}

async function events(server: AgentServerApp, id: string): Promise<Event[]> {
  const response = await server.app.inject(`/api/conversations/${id}/events/search?limit=100`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: Event[] }>().items;
}

// Adapted from pinned TestEventServiceStartWithRunningStatus. TS restores event logs
// without persisted execution status, and parallel execution may leave several missing
// results. A retry that arrived after the crash must not prevent restoring those results.
test.each([0, 1, 3])('restart repairs %i completed results in a three-tool batch without replaying tools or losing history', async (completed) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-orphaned-tools-'));
  const secretStore = new InMemorySecretStore();
  await secretStore.set(llmProviderSecretRef('litellm_proxy'), 'fixture-key');
  const requests: { messages: ChatMessage[] }[] = [];
  // Only provider HTTP is mocked: profile resolution, Agent, EventService, local
  // persistence, startup ownership and request/event projection all remain real.
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://proxy.example.test/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body)) as { messages: ChatMessage[] });
    return new Response(JSON.stringify({
      id: 'resumed-response', model: 'anthropic/claude-haiku-4-5',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'finish-resumed', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ message: 'resumed safely' }) } },
      ] } }],
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const options = { secretStore, config: {
    conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
    bashEventsPath: path.join(root, 'bash'), workspaceRoot: root,
  } };
  let server = await createAgentServerApp(options);
  try {
    const profile = llmProfileSchema.parse({ profileId: 'recovery-haiku', providerId: 'litellm_proxy', model: 'anthropic/claude-haiku-4-5', baseUrl: 'https://proxy.example.test/v1' });
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/recovery-haiku', payload: profile })).statusCode).toBe(201);
    const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      agent: { llm_profile_ref: profile.profileId, tools: ['terminal', 'finish'], condenser: { enabled: false } }, workspace: { working_dir: root },
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const service = (await server.conversationService.getEventService(id))!;
    const markers = [0, 1, 2].map((index) => path.join(root, `must-not-reexecute-${index}`));
    const calls = markers.map((marker, index) => ({ id: `interrupted-${index}`, name: 'terminal', arguments: JSON.stringify({ command: `touch '${marker}'` }), origin: 'completion' }));
    const actions = actionEventsFromMessage(messageSchema.parse({ role: 'assistant', tool_calls: calls }), 'interrupted-response');
    const observations = actions.slice(0, completed).map((action) => observationEventSchema.parse({
      action_id: action.id, tool_name: action.tool_name, tool_call_id: action.tool_call_id,
      observation: { text: `Original completed result for ${action.tool_call_id}` },
    }));
    const oldError = conversationErrorEventSchema.parse({ source: 'environment', code: 'LLMRequestError', detail: 'Provider rejected an earlier continuation with a missing tool result.' });
    await service.state.appendEventsAsync([
      messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'Original task.' }] } }),
      createLlmUsageEvent(profile, { responseId: 'interrupted-response', model: profile.model,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }, { startedAt: 1_000, completedAt: 1_010 }),
      ...actions, ...observations,
      messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'A retry already saved after the crash.' }] } }),
      oldError,
    ]);
    const beforeEvents = await events(server, id);
    const beforeStats = (await info(server, id)).stats;
    await server.app.close();
    server = await createAgentServerApp(options);

    const repaired = await events(server, id);
    const errors = repaired.filter((event) => event.kind === 'AgentErrorEvent');
    expect(errors.map((event) => event.tool_call_id)).toEqual(calls.slice(completed).map((call) => call.id));
    for (const error of errors) {
      expect(error).toMatchObject({ classification: { kind: 'internal', retryable: false } });
      expect(error.error).toContain('restart');
    }
    expect(repaired.slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect((await info(server, id)).stats).toEqual(beforeStats);
    expect(requests).toHaveLength(0);

    // Persisted repair is idempotent, including another restart before any prompt.
    await server.app.close();
    server = await createAgentServerApp(options);
    expect(await events(server, id)).toEqual(repaired);
    expect((await info(server, id)).stats).toEqual(beforeStats);
    const continued = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Please continue now.', run: true } });
    expect(continued.statusCode).toBe(200);
    await expect.poll(async () => (await info(server, id)).execution_status).toBe('finished');
    expect(requests).toHaveLength(1);
    const messages = requests[0]!.messages;
    const batchIndex = messages.findIndex((message) => message.tool_calls?.some((call) => call.id === calls[0]!.id));
    expect(batchIndex).toBeGreaterThanOrEqual(0);
    const results = messages.slice(batchIndex + 1, batchIndex + 1 + calls.length);
    expect(results.map((message) => [message.role, message.tool_call_id])).toEqual(calls.map((call) => ['tool', call.id]));
    observations.forEach((observation, index) => expect(JSON.stringify(results[index]!.content)).toContain(observation.observation.text));
    for (const result of results.slice(completed)) expect(JSON.stringify(result.content)).toContain('restart');
    expect(JSON.stringify(messages.slice(batchIndex + calls.length + 1))).toContain('A retry already saved after the crash.');
    expect(JSON.stringify(messages.slice(batchIndex + calls.length + 1))).toContain('Please continue now.');
    expect(markers.map((marker) => existsSync(marker))).toEqual([false, false, false]);

    const afterEvents = await events(server, id);
    expect(afterEvents.slice(0, repaired.length)).toEqual(repaired);
    expect(afterEvents.filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([oldError]);
    expect(afterEvents.filter((event) => event.kind === 'AgentErrorEvent')).toEqual(errors);
    const finished = await info(server, id);
    expect(finished.metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: 300, completion_tokens: 30 });
    await server.app.close();
    server = await createAgentServerApp(options);
    expect((await info(server, id)).stats).toEqual(finished.stats);
    expect(await events(server, id)).toEqual(afterEvents);
  } finally {
    await server.app.close();
    provider.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves an active owner untouched and preserves all saved result types by tool-call identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-orphaned-owner-'));
  const first = new ConversationService({ persistenceDir: root, ownerInstanceId: 'first-owner' });
  let next: ConversationService | undefined;
  try {
    const { info: created } = await first.startConversation(startConversationRequestSchema.parse({}));
    const source = (await first.getEventService(created.id))!;
    const actions = actionEventsFromMessage(messageSchema.parse({ role: 'assistant', tool_calls:
      [0, 1, 2, 3].map((index) => ({ id: `call-${index}`, name: 'terminal', arguments: '{}', origin: 'completion' })),
    }), 'saved-response');
    await source.state.appendEventsAsync([
      ...actions,
      observationEventSchema.parse({ action_id: 'imported-observation-action-id', tool_name: 'terminal', tool_call_id: 'call-0', observation: { text: 'original output' } }),
      userRejectObservationSchema.parse({ action_id: 'imported-rejection-action-id', tool_name: 'terminal', tool_call_id: 'call-1', rejection_reason: 'original rejection' }),
      agentErrorEventSchema.parse({ tool_name: 'terminal', tool_call_id: 'call-2', error: 'original tool failure' }),
    ]);
    const original = structuredClone(source.state.events);
    next = new ConversationService({ persistenceDir: root, ownerInstanceId: 'competing-owner' });
    expect(await next.getConversation(created.id)).toBeNull();
    source.state.syncFromDisk();
    expect(source.state.events).toEqual(original);
    await next.close();
    await first.close();
    next = new ConversationService({ persistenceDir: root, ownerInstanceId: 'restoring-owner' });
    const restored = (await next.getEventService(created.id))!;
    expect(restored.state.events.slice(0, original.length)).toEqual(original);
    expect(restored.state.events.slice(original.length)).toMatchObject([
      { kind: 'AgentErrorEvent', tool_call_id: 'call-3', classification: { kind: 'internal', retryable: false } },
    ]);
  } finally {
    await next?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed repair releases every claimed lease and resumes an incomplete repair on the next startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-orphaned-failure-'));
  const first = new ConversationService({ persistenceDir: root, ownerInstanceId: 'first-owner' });
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  let next: ConversationService | undefined;
  let append: ReturnType<typeof vi.spyOn> | undefined;
  const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Startup must not call a provider'));
  try {
    for (const id of ids) {
      await first.startConversation(startConversationRequestSchema.parse({ id }));
      const service = (await first.getEventService(id))!;
      await service.state.appendEventsAsync(actionEventsFromMessage(messageSchema.parse({ role: 'assistant', tool_calls:
        [0, 1].map((index) => ({ id: `call-${id}-${index}`, name: 'terminal', arguments: '{}', origin: 'completion' })),
      }), `response-${id}`));
    }
    await first.close();
    const originalAppend = ConversationState.prototype.appendEventAsync;
    let appended = 0;
    append = vi.spyOn(ConversationState.prototype, 'appendEventAsync').mockImplementation(async function (this: ConversationState, event: Event) {
      if (event.kind === 'AgentErrorEvent' && ++appended === 4) throw new Error('fixture: disk full during repair');
      return originalAppend.call(this, event);
    });
    next = new ConversationService({ persistenceDir: root, ownerInstanceId: 'failed-owner' });
    await expect(next.getConversation(ids[0]!)).rejects.toThrow('fixture: disk full during repair');
    expect(ids.map((id) => existsSync(path.join(root, id, leaseFileName)))).toEqual([false, false]);
    await expect(next.close()).resolves.toBeUndefined();
    append.mockRestore();
    append = undefined;
    next = new ConversationService({ persistenceDir: root, ownerInstanceId: 'replacement-owner' });
    for (const id of ids) {
      const restored = (await next.getEventService(id))!;
      expect(restored.state.events.filter((event) => event.kind === 'AgentErrorEvent').map((event) => event.tool_call_id))
        .toEqual([`call-${id}-0`, `call-${id}-1`]);
    }
    expect(provider).not.toHaveBeenCalled();
  } finally {
    append?.mockRestore();
    await next?.close();
    await first.close();
    provider.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
