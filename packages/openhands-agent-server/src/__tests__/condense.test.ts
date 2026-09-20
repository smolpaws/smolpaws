import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent, AgentResetCondenser, FinishTool, InMemorySecretStore, LLMSummarizingCondenser, NoOpCondenser, ToolDefinition, View,
  actionEventsFromMessage, conversationExecutionStatus, eventSchema, llmProfileSchema, messageSchema, metricsSnapshot,
  type Event, type LLMCompletionResponse,
} from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { pathContainsPlaintext } from '../../examples/plaintextScan.js';
import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';
import { ConversationLeaseHeldError, ConversationLeaseInvalidError, ConversationOwnershipLostError, leaseFileName } from '../conversationLease.js';
import type { AgentFactoryContext, EventService } from '../eventService.js';
import type { StoredConversation } from '../models.js';

// Pinned Python conversation_router.condense -> EventService -> LocalConversation.
// Real REST/WebSocket, SDK step lock, EventLog, leases and reconstruction; no provider network.
const roots: string[] = [], servers: AgentServerApp[] = [], sockets: WebSocket[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(() => resolve());
  return { promise, resolve };
}
const profile = llmProfileSchema.parse({ profileId: 'agent-fixture', providerId: 'openai', model: 'fixture' });
const summaryProfile = llmProfileSchema.parse({ ...profile, profileId: 'condenser-fixture' });
const summaryResponse = (): LLMCompletionResponse => ({ responseId: 'summary-provider-id', model: 'fixture',
  usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 }, message: messageSchema.parse({ role: 'assistant', content: 'Earlier public work completed.' }) });
const finishResponse = (): LLMCompletionResponse => ({ responseId: 'agent-provider-id', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
  message: messageSchema.parse({ role: 'assistant', tool_calls: [{ id: 'finish-call', name: 'finish', arguments: '{"message":"done"}', origin: 'completion' }] }) });
interface FixtureOptions {
  readonly kind?: 'none' | 'noop' | 'agent_reset';
  readonly requestAgent?: unknown;
  readonly summary?: () => Promise<LLMCompletionResponse>;
  readonly main?: () => Promise<LLMCompletionResponse>;
  readonly beforeCreate?: (context: AgentFactoryContext) => Promise<void>;
  readonly tools?: ToolDefinition[];
  readonly sessionApiKey?: string;
}
async function fixture(input: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-condense-'));
  roots.push(root);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in condensation test'));
  const summary = vi.fn(input.summary ?? (async () => summaryResponse()));
  const main = vi.fn(input.main ?? (async () => finishResponse()));
  const factory = vi.fn(async (_request: unknown, context: AgentFactoryContext) => {
    await input.beforeCreate?.(context);
    return new Agent({ llm: { profile, complete: main }, tools: input.tools ?? [FinishTool.create()],
      ...(input.kind === 'none' ? {} : { condenser: input.kind === 'agent_reset' ? new AgentResetCondenser() : input.kind === 'noop' ? new NoOpCondenser()
        : new LLMSummarizingCondenser({ llm: { profile: summaryProfile, complete: summary }, maxSize: 100, keepFirst: 0, hardContextResetMaxRetries: 1 }) }),
    });
  });
  const options: AgentServerAppOptions = { agentFactory: factory, secretStore: new InMemorySecretStore(), config: {
    conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root,
    ...(input.sessionApiKey === undefined ? {} : { sessionApiKey: input.sessionApiKey }),
  } };
  const server = await createAgentServerApp(options);
  servers.push(server);
  const headers = input.sessionApiKey === undefined ? {} : { 'x-session-api-key': input.sessionApiKey };
  const created = await server.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: input.requestAgent === undefined ? {} : { agent: input.requestAgent } });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ id: string }>().id;
  for (const text of ['Public task one.', 'Public task two.']) {
    const sent = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, headers, payload: { role: 'user', content: text, run: false } });
    expect(sent.statusCode).toBe(200);
  }
  const service = (await server.conversationService.getEventService(id))!;
  return { server, id, service, options, root, summary, main, factory, headers };
}
const condense = (f: Awaited<ReturnType<typeof fixture>>) => f.server.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/condense`, headers: f.headers });
async function savedEvents(server: AgentServerApp, id: string): Promise<Event[]> {
  const reply = await server.app.inject(`/api/conversations/${id}/events/search?limit=100`);
  expect(reply.statusCode).toBe(200);
  return reply.json<{ items: unknown[] }>().items.map(event => eventSchema.parse(event));
}
const relevant = (events: readonly Event[]) => events.filter(event => event.kind === 'Condensation' || event.kind === 'CondensationRequest'
  || event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage');
function privateSave(service: EventService) {
  return service as unknown as { saveConversation(stored: StoredConversation): Promise<void> };
}

test('manual endpoint authenticates before lookup, and a missing owned conversation is 404', async () => {
  const f = await fixture({ sessionApiKey: 'test-session-key' });
  const url = `/api/conversations/${f.id}/condense`;
  expect((await f.server.app.inject({ method: 'POST', url })).statusCode).toBe(401);
  expect((await f.server.app.inject({ method: 'POST', url, headers: { 'x-session-api-key': 'wrong' } })).statusCode).toBe(401);
  const missing = await f.server.app.inject({ method: 'POST', url: '/api/conversations/00000000-0000-4000-8000-000000000000/condense', headers: f.headers });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ detail: 'Conversation not found' });
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.summary).not.toHaveBeenCalled();
  expect((await condense(f)).statusCode).toBe(200);
});

test.each(['none', 'noop'] as const)('a %s condenser fails with Python-compatible 500 without appending a request', async kind => {
  const f = await fixture({ kind });
  const before = [...f.service.state.events];
  const response = await condense(f);
  expect(response.statusCode).toBe(500);
  expect(response.json().detail).toContain('Cannot condense conversation');
  expect(f.service.state.events).toEqual(before);
  expect(f.main).not.toHaveBeenCalled();
});

test('agent-controlled SDK maintenance rejection retains its typed HTTP response', async () => {
  const f = await fixture({ kind: 'agent_reset', sessionApiKey: 'test-session-key' });
  const before = [...f.service.state.events];
  const response = await condense(f);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: 'agent_controlled_condensation', detail: expect.stringMatching(/agent.*condense/i) });
  expect(f.service.state.events).toEqual(before);
  expect(f.main).not.toHaveBeenCalled();
  expect(f.summary).not.toHaveBeenCalled();
});

test('stored agent-reset configuration rejects maintenance before client or fallback preparation', async () => {
  const f = await fixture({ requestAgent: {
    llm_profile_ref: 'missing-main', condenser: { condenser_kind: 'agent_reset' },
    hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'missing-fallback' },
  } });
  const before = [...f.service.state.events];
  const response = await condense(f);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toHaveProperty('code', 'agent_controlled_condensation');
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.service.state.events).toEqual(before);
  expect(f.main).not.toHaveBeenCalled();
  expect(f.summary).not.toHaveBeenCalled();
});

test('manual condensation persists and publishes every event once over real WebSocket while preserving pause', async () => {
  const f = await fixture();
  await f.server.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/pause` });
  // Pause the service state explicitly before initial construction, matching a restored paused view.
  f.service.state.executionStatus = conversationExecutionStatus.PAUSED;
  await f.server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server');
  const emitted: Event[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/events/${f.id}`);
  sockets.push(socket);
  socket.addEventListener('message', message => { emitted.push(eventSchema.parse(JSON.parse(String(message.data)))); });
  await expect.poll(() => emitted.length).toBeGreaterThan(0);
  const response = await condense(f);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ success: true });
  const saved = await savedEvents(f.server, f.id);
  expect(saved.filter(event => event.kind === 'Condensation')).toHaveLength(1);
  expect(saved.filter(event => event.kind === 'CondensationRequest')).toHaveLength(1);
  const condensed = saved.find(event => event.kind === 'Condensation')!;
  expect(condensed.forgotten_event_ids.size).toBe(2);
  expect(View.fromEvents(saved).events.some(event => event.kind === 'CondensationSummaryEvent')).toBe(true);
  await expect.poll(() => relevant(emitted)).toEqual(relevant(saved));
  expect(new Set(relevant(emitted).map(event => event.id)).size).toBe(relevant(emitted).length);
  expect(f.service.state.executionStatus).toBe('paused');
  expect(f.main).not.toHaveBeenCalled();
  expect(f.summary).toHaveBeenCalledTimes(1);
  expect(f.service.state.stats.usage_to_metrics.condenser?.records).toHaveLength(1);
  await expect.poll(() => emitted.at(-1)).toMatchObject({ kind: 'ConversationStateUpdateEvent', key: 'full_state', value: { execution_status: 'paused' } });
});

test('a running tool step settles before manual condensation; the request waits instead of 409', async () => {
  const entered = deferred(), release = deferred();
  const executor = vi.fn(async () => { entered.resolve(); await release.promise; return { text: 'Completed once' }; });
  const tool = new ToolDefinition({ name: 'hold', description: 'Hold a tool batch', inputSchema: z.object({}), executor });
  let calls = 0;
  const f = await fixture({ tools: [tool, FinishTool.create()], main: async () => ++calls === 1
    ? { usage: null, message: messageSchema.parse({ role: 'assistant', tool_calls: [{ id: 'hold-call', name: 'hold', arguments: '{}', origin: 'completion' }] }) }
    : finishResponse() });
  await f.service.run();
  await entered.promise;
  const pending = condense(f);
  let resolved = false; void pending.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(resolved).toBe(false);
  expect(f.summary).not.toHaveBeenCalled();
  release.resolve();
  expect((await pending).statusCode).toBe(200);
  await f.service.whenIdle();
  expect(executor).toHaveBeenCalledTimes(1);
  const events = f.service.state.events;
  expect(events.findIndex(event => event.kind === 'ObservationEvent' && event.tool_name === 'hold')).toBeLessThan(events.findIndex(event => event.kind === 'CondensationRequest'));
  expect(f.main).toHaveBeenCalledTimes(2);
});

test('concurrent manual operations share initial construction and its guarded request updater', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ beforeCreate: async context => {
    expect(context.updateRequest).toBeTypeOf('function');
    await context.updateRequest!(request => ({ ...request, title: 'Captured once under owner guard' }));
    entered.resolve(); await release.promise;
  } });
  const first = condense(f), second = condense(f);
  await entered.promise;
  let idle = false; const settled = f.service.whenIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(idle).toBe(false);
  expect(f.factory).toHaveBeenCalledTimes(1);
  release.resolve();
  expect((await first).statusCode).toBe(200);
  expect((await second).statusCode).toBe(200);
  await settled;
  expect(f.summary).toHaveBeenCalledTimes(2);
  const metadata = JSON.parse(await readFile(path.join(f.root, 'conversations', f.id, 'meta.json'), 'utf8'));
  expect(metadata.request.title).toBe('Captured once under owner guard');
});

test.each(['close', 'delete'] as const)('%s waits for manual summary and final publication before releasing ownership', async mode => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ summary: async () => { entered.resolve(); await release.promise; return summaryResponse(); } });
  const emitted: Event[] = [];
  let subscriberClosed = false;
  const subscriber = Object.assign((event: Event) => { emitted.push(event); }, { close: () => { subscriberClosed = true; } });
  await f.service.subscribeToEvents(subscriber);
  const pending = f.service.condense();
  await entered.promise;
  let finished = false;
  const closing = (mode === 'close' ? f.server.conversationService.close() : f.server.conversationService.deleteConversation(f.id)).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false);
  expect(subscriberClosed).toBe(false);
  expect(existsSync(path.join(f.root, 'conversations', f.id, leaseFileName))).toBe(true);
  release.resolve();
  await pending; await closing;
  expect(subscriberClosed).toBe(true);
  expect(emitted.filter(event => event.kind === 'Condensation')).toHaveLength(1);
  expect(existsSync(path.join(f.root, 'conversations', f.id, leaseFileName))).toBe(false);
});

test.each(['provider', 'factory', 'object'] as const)('manual %s failures reject safely without resuming or creating run errors', async origin => {
  const secret = 'condensation-fixture-secret-not-for-output';
  const failure = Object.assign(new Error(`Failed api_key=${secret}; Authorization: Bearer ${secret}`), { request: { token: secret } });
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture(origin === 'provider' ? { summary: async () => { throw failure; } } : { beforeCreate: async () => { throw origin === 'object' ? { token: secret, toString: () => secret } : failure; } });
  f.service.state.executionStatus = conversationExecutionStatus.PAUSED;
  const emitted: Event[] = [];
  await f.service.subscribeToEvents(event => { emitted.push(event); });
  const response = await condense(f);
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(await pathContainsPlaintext(f.root, secret)).toBe(false);
  expect(f.service.state.executionStatus).toBe('paused');
  expect(f.service.state.events.some(event => event.kind === 'ConversationErrorEvent')).toBe(false);
  expect(f.main).not.toHaveBeenCalled();
  await f.service.whenIdle();
  expect(relevant(emitted)).toEqual(relevant(f.service.state.events));
  if (origin === 'provider') {
    expect(f.service.state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(1);
    expect(f.service.state.stats.usage_to_metrics.condenser?.records).toHaveLength(f.summary.mock.calls.length);
  }
});

test('metadata failure after a paid summary still publishes its saved events once and leaves future maintenance usable', async () => {
  const f = await fixture();
  const emitted: Event[] = [];
  await f.service.subscribeToEvents(event => { emitted.push(event); });
  const save = vi.spyOn(privateSave(f.service), 'saveConversation').mockRejectedValueOnce(new Error('Metadata unavailable'));
  expect((await condense(f)).statusCode).toBe(500);
  expect(f.summary).toHaveBeenCalledTimes(1);
  expect(relevant(emitted)).toEqual(relevant(f.service.state.events));
  expect(f.service.state.executionStatus).toBe('idle');
  expect(f.service.state.events.some(event => event.kind === 'ConversationErrorEvent')).toBe(false);
  await f.service.whenIdle();
  save.mockRestore();
  expect((await condense(f)).statusCode).toBe(200);
  expect(new Set(relevant(emitted).map(event => event.id)).size).toBe(relevant(emitted).length);
});

test.each([
  ['held', new ConversationLeaseHeldError('public-fixture', 'replacement-owner', 123), 409],
  ['invalid', new ConversationLeaseInvalidError('public-fixture', 'payload does not match the lease schema'), 409],
  ['lost', new ConversationOwnershipLostError('public-fixture', 'former-owner', 1), 409],
  ['ordinary', new Error('Metadata failed'), 500],
] as const)('manual provider failure followed by %s metadata failure preserves HTTP classification and publication', async (_kind, metadataError, statusCode) => {
  const secret = 'combined-condensation-fixture-secret';
  const f = await fixture({ summary: async () => { throw new Error(`Provider failed api_key=${secret}`); } });
  f.service.state.executionStatus = conversationExecutionStatus.PAUSED;
  const emitted: Event[] = [];
  await f.service.subscribeToEvents(event => { emitted.push(event); });
  const save = vi.spyOn(privateSave(f.service), 'saveConversation').mockRejectedValueOnce(metadataError);
  const response = await condense(f);
  expect(response.statusCode).toBe(statusCode);
  if (statusCode === 409) expect(response.json()).toEqual({ detail: metadataError.message });
  else {
    expect(response.json().detail).toContain('Provider failed');
    expect(response.json().detail).not.toContain('Metadata failed');
  }
  expect(response.body).not.toContain(secret);
  expect(await pathContainsPlaintext(f.root, secret)).toBe(false);
  expect(f.service.state.executionStatus).toBe('paused');
  expect(f.service.state.events.some(event => event.kind === 'ConversationErrorEvent')).toBe(false);
  expect(f.main).not.toHaveBeenCalled();
  // One ordinary attempt and the single configured hard-reset attempt are recorded.
  expect(f.summary).toHaveBeenCalledTimes(2);
  expect(f.service.state.stats.usage_to_metrics.condenser?.records).toHaveLength(2);
  const saved = relevant(await savedEvents(f.server, f.id));
  expect(saved.some(event => event.kind === 'CondensationRequest')).toBe(true);
  expect(saved.some(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage')).toBe(true);
  expect(relevant(emitted)).toEqual(saved);
  expect(new Set(relevant(emitted).map(event => event.id)).size).toBe(saved.length);
  await f.service.whenIdle();
  save.mockRestore();
});

test('input arriving during a summary stays unconsumed and can run afterward', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ summary: async () => { entered.resolve(); await release.promise; return summaryResponse(); } });
  const pending = f.service.condense();
  await entered.promise;
  const late = await f.service.sendMessage(messageSchema.parse({ role: 'user', content: 'New request while summarizing.' }), false);
  release.resolve();
  await pending;
  expect(f.main).not.toHaveBeenCalled();
  const reduced = f.service.state.events.find(event => event.kind === 'Condensation')!;
  expect(reduced.forgotten_event_ids.has(late.event.id)).toBe(false);
  expect(View.fromEvents(f.service.state.events).events.some(event => event.id === late.event.id)).toBe(true);
  await f.service.run();
  await f.service.whenIdle();
  expect(f.main).toHaveBeenCalledTimes(1);
  expect(f.service.state.executionStatus).toBe('finished');
});

test('restart and fork preserve summaries and independent condenser accounting without repeating paid work', async () => {
  const f = await fixture();
  expect((await condense(f)).statusCode).toBe(200);
  const before = await savedEvents(f.server, f.id), stats = metricsSnapshot(f.service.state.stats);
  await f.server.app.close();
  const restored = await createAgentServerApp(f.options); servers.push(restored);
  expect(await savedEvents(restored, f.id)).toEqual(before);
  expect(metricsSnapshot((await restored.conversationService.getEventService(f.id))!.state.stats)).toEqual(stats);
  expect(f.summary).toHaveBeenCalledTimes(1);
  for (const reset_metrics of [false, true]) {
    const response = await restored.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/fork`, payload: { reset_metrics } });
    expect(response.statusCode).toBe(201);
    const fork = (await restored.conversationService.getEventService(response.json<{ id: string }>().id))!;
    expect(fork.state.events.filter(event => event.kind === 'Condensation')).toEqual(before.filter(event => event.kind === 'Condensation'));
    expect(metricsSnapshot(fork.state.stats).coverage.completion_count).toBe(reset_metrics ? 0 : stats.coverage.completion_count);
    expect(View.fromEvents(fork.state.events).events.some(event => event.kind === 'CondensationSummaryEvent')).toBe(true);
  }
  expect(f.summary).toHaveBeenCalledTimes(1);
  const continuation = await restored.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/events`, payload: { role: 'user', content: 'Continue once.', run: true } });
  expect(continuation.statusCode).toBe(200);
  await (await restored.conversationService.getEventService(f.id))!.whenIdle();
  expect(f.main).toHaveBeenCalledTimes(1);
});

test('manual condensation after orphan restoration never replays an interrupted tool', async () => {
  const execute = vi.fn(() => ({ text: 'must not execute' }));
  const f = await fixture({ tools: [new ToolDefinition({ name: 'interrupted', description: 'Public fixture', inputSchema: z.object({}), executor: execute }), FinishTool.create()] });
  const actions = actionEventsFromMessage(messageSchema.parse({ role: 'assistant', tool_calls: [{ id: 'unknown-outcome', name: 'interrupted', arguments: '{}', origin: 'completion' }] }), 'interrupted-response');
  await f.service.state.appendEventsAsync(actions);
  await f.server.app.close();
  const restored = await createAgentServerApp(f.options); servers.push(restored);
  const service = (await restored.conversationService.getEventService(f.id))!;
  expect(service.state.events.filter(event => event.kind === 'AgentErrorEvent')).toHaveLength(1);
  const result = await restored.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/condense` });
  expect(result.statusCode).toBe(200);
  expect(execute).not.toHaveBeenCalled();
  expect(f.main).not.toHaveBeenCalled();
  expect(service.state.events.filter(event => event.kind === 'AgentErrorEvent')).toHaveLength(1);
  expect(service.state.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
});
