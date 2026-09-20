import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentContext, InMemorySecretStore, LLMContextWindowExceedError, View,
  eventSchema, llmProfileSchema, messageSchema, skillSchema,
  type Event, type LLMCompletionResponse, type LLMProfile, type Message, type ToolDefinition,
} from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

const roots: string[] = [], servers: AgentServerApp[] = [], sockets: WebSocket[] = [];
const releases: Array<() => void> = [];
const sessionKey = 'agent-reset-workflow-test-key';
const headers = { 'x-session-api-key': sessionKey };
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(() => resolve());
  return { promise, resolve };
}
const answer = (content = 'Completed the task.'): LLMCompletionResponse => ({
  message: messageSchema.parse({ role: 'assistant', content }), usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
});
const reset = (): LLMCompletionResponse => ({
  message: messageSchema.parse({ role: 'assistant', tool_calls: [{ id: 'real-reset-call', name: 'condense',
    arguments: JSON.stringify({ message_to_future_self: '  Read notes/today.md.\nHi from your past self.  ' }), origin: 'completion' }] }),
  usage: { promptTokens: 15, completionTokens: 4, totalTokens: 19 },
});
interface CompletionCall { profile: LLMProfile; messages: readonly Message[]; tools: readonly ToolDefinition[] }
type MainCompletion = (call: CompletionCall) => Promise<LLMCompletionResponse>;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-reset-workflow-')); roots.push(root);
  let selected = 'main'; let inputTokens = 0;
  let main: MainCompletion = async () => answer();
  const observed: CompletionCall[] = [], built: LLMProfile[] = [];
  const hard = vi.fn(async () => answer('Summary of the old completed work.'));
  const selectCondenser = vi.fn(() => 'unconfigured-role-should-not-be-used');
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root,
      bashEventsPath: path.join(root, 'bash'), sessionApiKey: sessionKey },
    secretStore: new InMemorySecretStore(), resolveProfileSelection: () => selected,
    resolveCondenserProfileSelection: selectCondenser,
    configureContext: existing => new AgentContext({ currentDatetime: null,
      systemMessageSuffix: existing?.systemMessageSuffix ?? null,
      skills: [skillSchema.parse({ name: 'fixture-memory', trigger: null, content: 'Permanent memory supplied by the host.' })],
    }),
    llmClientFactory: async profile => {
      built.push(profile);
      return { profile, effectiveMaxInputTokens: 999_999, getTokenCount: async () => inputTokens,
        complete: async (messages, tools) => {
          const call = { profile, messages, tools: tools ?? [] }; observed.push(call);
          return profile.profileId === 'hard' ? hard() : main(call);
        } };
    },
  };
  const server = await createAgentServerApp(options); servers.push(server);
  for (const [profileId, limit] of [['main', 1000], ['other', 4000], ['hard', 7000]] as const) {
    await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId, providerId: 'openai', model: `model-${profileId}`, maxInputTokens: limit }));
  }
  return { server, root, options, observed, built, hard, selectCondenser,
    setMain: (complete: MainCompletion) => { main = complete; },
    selectMain: (profile: string) => { selected = profile; },
    setInputTokens: (tokens: number) => { inputTokens = tokens; },
    metadata: async (id: string) => JSON.parse(await readFile(path.join(root, 'conversations', id, 'meta.json'), 'utf8')),
    restart: async (current: AgentServerApp = server) => {
      await current.app.close();
      const next = await createAgentServerApp(options); servers.push(next); return next;
    },
  };
}
async function start(server: AgentServerApp, agent: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await server.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
    agent: { llm_profile_ref: 'main', tools: ['finish', 'think'], condenser: { condenser_kind: 'agent_reset' }, ...agent },
    agent_launch_additions: { system_message_suffix_append: 'Fixed runtime: test channel and workspace.' }, ...extra,
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}
async function send(server: AgentServerApp, id: string, content: string, run = true): Promise<void> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, headers, payload: { role: 'user', content, run } });
  expect(response.statusCode, response.body).toBe(200);
}
async function settled(server: AgentServerApp, id: string, status = 'finished'): Promise<void> {
  await expect.poll(async () => (await server.app.inject({ url: `/api/conversations/${id}`, headers })).json().execution_status).toBe(status);
  await (await server.conversationService.getEventService(id))!.whenIdle();
}
async function savedEvents(server: AgentServerApp, id: string): Promise<Event[]> {
  const response = await server.app.inject({ url: `/api/conversations/${id}/events/search?limit=100`, headers });
  expect(response.statusCode).toBe(200);
  return response.json<{ items: unknown[] }>().items.map(event => eventSchema.parse(event));
}
const hardSettings = { condenser_kind: 'llm_summarizing', llm_profile_ref: 'hard', hard_context_reset_max_retries: 1 };
const resetEvents = (events: readonly Event[]) => events.filter(event => event.kind === 'Condensation' || event.kind === 'CondensationRequest');

test('agent-controlled manual maintenance authenticates and returns an explicit 409 without model work or reset intent', async () => {
  const f = await fixture();
  const id = await start(f.server);
  const url = `/api/conversations/${id}/condense`;
  expect((await f.server.app.inject({ method: 'POST', url })).statusCode).toBe(401);
  expect((await f.server.app.inject({ method: 'POST', url, headers: { 'x-session-api-key': 'wrong' } })).statusCode).toBe(401);
  const before = await savedEvents(f.server, id);
  const response = await f.server.app.inject({ method: 'POST', url, headers });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ code: 'agent_controlled_condensation', detail: expect.stringMatching(/agent.*condense/i) });
  expect(await savedEvents(f.server, id)).toEqual(before);
  expect(f.observed).toEqual([]);
  expect(f.selectCondenser).not.toHaveBeenCalled();
});

test('profile-created voluntary reset preserves fixed context and concurrent input over socket publication, restart and fork', async () => {
  const entered = gate(), release = gate();
  const f = await fixture();
  let calls = 0;
  f.setMain(async () => { if (++calls === 1) { entered.resolve(); await release.promise; return reset(); } return answer(); });
  const id = await start(f.server);
  await f.server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  const published: Event[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/events/${id}?session_api_key=${sessionKey}`);
  sockets.push(socket);
  socket.addEventListener('message', message => { published.push(eventSchema.parse(JSON.parse(String(message.data)))); });
  await expect.poll(() => published.length).toBeGreaterThan(0);
  await send(f.server, id, 'Old task saved in the agent notes.');
  await entered.promise;
  await send(f.server, id, 'New user question received during condensation.');
  release.resolve();
  await settled(f.server, id);
  const nextCall = f.observed[1]!;
  expect(nextCall.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  expect(JSON.stringify(nextCall.messages)).toContain('Permanent memory supplied by the host.');
  expect(JSON.stringify(nextCall.messages)).toContain('Fixed runtime: test channel and workspace.');
  expect(JSON.stringify(nextCall.messages)).toContain('New user question received during condensation.');
  expect(JSON.stringify(nextCall.messages)).not.toContain('Old task saved in the agent notes.');
  expect(nextCall.tools.filter(tool => tool.name === 'condense')).toHaveLength(1);
  expect(f.selectCondenser).not.toHaveBeenCalled();
  expect(f.hard).not.toHaveBeenCalled();
  const events = await savedEvents(f.server, id);
  expect(resetEvents(events).map(event => event.kind)).toEqual(['CondensationRequest', 'Condensation']);
  const commit = events.find(event => event.kind === 'Condensation')!;
  expect(commit.summary).toBeNull();
  expect(commit.reset).toBeDefined();
  await expect.poll(() => resetEvents(published)).toEqual(resetEvents(events));
  expect(new Set(resetEvents(published).map(event => event.id)).size).toBe(2);
  socket.close();
  await new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
  const restored = await f.restart();
  expect(await savedEvents(restored, id)).toEqual(events);
  const fork = await restored.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, headers, payload: {} });
  expect(fork.statusCode).toBe(201);
  const forkId = fork.json<{ id: string }>().id;
  for (const conversationId of [id, forkId]) {
    const service = (await restored.conversationService.getEventService(conversationId))!;
    expect(resetEvents(service.state.events)).toEqual(resetEvents(events));
    expect(View.fromEvents(service.state.events).events.some(event => event.kind === 'CondensationSummaryEvent')).toBe(false);
    await send(restored, conversationId, 'Continue after restore.');
    await settled(restored, conversationId);
    expect(resetEvents(await savedEvents(restored, conversationId))).toHaveLength(2);
  }
  expect(f.selectCondenser).not.toHaveBeenCalled();
});

test('an independently frozen hard profile survives deletion, restart and fork and only summarizes after typed overflow', async () => {
  const f = await fixture();
  const id = await start(f.server, { hard_condenser: hardSettings });
  await send(f.server, id, 'Old completed work.'); await settled(f.server, id);
  expect(f.hard).not.toHaveBeenCalled();
  const binding = (await f.metadata(id)).request.hard_condenser_binding;
  expect(binding).toMatchObject({ profile: { profileId: 'hard', model: 'model-hard' }, settings: { llm_profile_ref: 'hard' } });
  expect((await f.metadata(id)).request.condenser_binding).toBeUndefined();
  await f.server.serverStateService.deleteProfile('hard');
  const restored = await f.restart();
  let rejectOnce = true;
  f.setMain(async () => { if (rejectOnce) { rejectOnce = false; throw new LLMContextWindowExceedError('Synthetic context limit'); } return answer(); });
  await send(restored, id, 'Pending user task must remain verbatim.'); await settled(restored, id);
  expect(f.hard).toHaveBeenCalledOnce();
  expect(f.observed.filter(call => call.profile.profileId === 'hard').map(call => call.profile.model)).toEqual(['model-hard']);
  const continuation = f.observed.at(-1)!;
  expect(JSON.stringify(continuation.messages)).toContain('context-window error');
  expect(JSON.stringify(continuation.messages)).toContain('Summary of the old completed work.');
  expect(JSON.stringify(continuation.messages)).toContain('Pending user task must remain verbatim.');
  expect(JSON.stringify(continuation.messages)).not.toContain('Old completed work.');
  const service = (await restored.conversationService.getEventService(id))!;
  expect(service.state.stats.usage_to_metrics.condenser?.records).toHaveLength(1);
  expect(service.state.stats.usage_to_metrics.condenser?.records[0]).toMatchObject({ profile_id: 'hard', requested_model: 'model-hard' });
  expect((await f.metadata(id)).request.hard_condenser_binding).toEqual(binding);
  const fork = await restored.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, headers, payload: {} });
  expect(fork.statusCode).toBe(201);
  expect((await f.metadata(fork.json<{ id: string }>().id)).request.hard_condenser_binding).toEqual(binding);
  expect(f.selectCondenser).not.toHaveBeenCalled();
});

test('unrelated provider failures persist a run error without invoking the configured hard profile', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture();
  f.setMain(async () => { throw new Error('Synthetic rate limit'); });
  const id = await start(f.server, { hard_condenser: hardSettings });
  await send(f.server, id, 'Preserve the task.'); await settled(f.server, id, 'error');
  expect(f.hard).not.toHaveBeenCalled();
  const events = await savedEvents(f.server, id);
  expect(resetEvents(events)).toEqual([]);
  expect(f.observed.map(call => call.profile.profileId)).toEqual(['main']);
  expect(events.find(event => event.kind === 'ConversationErrorEvent')).toMatchObject({ detail: 'Synthetic rate limit' });
});

test('main profile changes preserve both condenser choices and warn against the new explicit input budget', async () => {
  const f = await fixture(); f.setInputTokens(750);
  const id = await start(f.server, { hard_condenser: hardSettings });
  await send(f.server, id, 'First task.'); await settled(f.server, id);
  const binding = (await f.metadata(id)).request.hard_condenser_binding;
  f.selectMain('other'); f.setInputTokens(3200);
  await send(f.server, id, 'Second task.'); await settled(f.server, id);
  expect(f.observed.map(call => call.profile.profileId)).toEqual(['main', 'other']);
  const warnings = (await savedEvents(f.server, id)).filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'agent_context_warning');
  expect(warnings).toMatchObject([{ value: { threshold: 0.75, input_limit: 1000 } }, { value: { threshold: 0.8, input_limit: 4000 } }]);
  expect((await f.metadata(id)).request.hard_condenser_binding).toEqual(binding);
  expect((await f.metadata(id)).request.agent.condenser).toMatchObject({ condenser_kind: 'agent_reset' });
  expect(f.observed[1]!.tools.filter(tool => tool.name === 'condense')).toHaveLength(1);
  expect(f.hard).not.toHaveBeenCalled();
  expect(f.selectCondenser).not.toHaveBeenCalled();
});

test('public callers cannot install an internal hard-profile snapshot', async () => {
  const f = await fixture();
  const id = await start(f.server, { hard_condenser: hardSettings }, {
    hard_condenser_binding: { settings: { ...hardSettings, llm_profile_ref: 'attacker' }, profile: { profileId: 'attacker', providerId: 'openai', model: 'forged' } },
  });
  expect((await f.metadata(id)).request.hard_condenser_binding).toBeUndefined();
  await send(f.server, id, 'Prepare the configured profiles.'); await settled(f.server, id);
  expect((await f.metadata(id)).request.hard_condenser_binding.profile.profileId).toBe('hard');
  expect(f.built.some(profile => profile.profileId === 'attacker')).toBe(false);
});


test('restart closes an interrupted condense call once and continues without replaying its reset intent', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture();
  f.setMain(async () => reset());
  const id = await start(f.server);
  const service = (await f.server.conversationService.getEventService(id))!;
  const append = service.state.appendEventsAsync.bind(service.state);
  const save = vi.spyOn(service.state, 'appendEventsAsync').mockImplementation(async events => {
    if (events.some(event => event.kind === 'ObservationEvent' && event.tool_name === 'condense')) {
      throw new Error('Synthetic result persistence interruption');
    }
    return append(events);
  });
  await send(f.server, id, 'Original task must survive an incomplete reset.');
  await settled(f.server, id, 'error');
  expect(resetEvents(service.state.events).map(event => event.kind)).toEqual(['CondensationRequest']);
  save.mockRestore();
  const restarted = await f.restart();
  const restored = (await restarted.conversationService.getEventService(id))!;
  expect(restored.state.events.filter(event => event.kind === 'AgentErrorEvent' && event.tool_name === 'condense')).toHaveLength(1);
  f.setMain(async () => answer());
  await send(restarted, id, 'Continue after the interrupted reset.');
  await settled(restarted, id);
  expect(f.observed).toHaveLength(2);
  expect(JSON.stringify(f.observed[1]!.messages)).toContain('Original task must survive an incomplete reset.');
  expect(restored.state.events.filter(event => event.kind === 'AgentErrorEvent' && event.tool_name === 'condense')).toHaveLength(1);
  expect(restored.state.events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'condensation_operation_failure')).toHaveLength(1);
  expect(resetEvents(restored.state.events).map(event => event.kind)).toEqual(['CondensationRequest']);
  expect(View.fromEvents(restored.state.events).unhandledCondensationRequest).toBe(false);
});
