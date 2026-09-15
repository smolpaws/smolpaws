import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, FinishTool, InMemorySecretStore, OpenAIChatClient, ThinkTool, llmProfileSchema, messageEventSchema, textContent, type Event } from '@smolpaws/openhands-agent';
import { describe, expect, test } from 'vitest';

import { createAgentServerApp, type AgentServerApp } from '../app.js';

interface Tokens {
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly reasoning_tokens: number | null;
}

interface Metrics {
  readonly accumulated_token_usage: Tokens | null;
  readonly accumulated_cost: number | null;
  readonly known_costs: Readonly<Record<string, number>>;
  readonly coverage: { readonly unmeasured_history: boolean };
  readonly token_usages?: readonly (Tokens & { readonly model: string; readonly response_id: string })[];
  readonly costs?: readonly unknown[];
  readonly response_latencies?: readonly unknown[];
}

interface Info {
  readonly id: string;
  readonly execution_status: string;
  readonly stats: { readonly usage_to_metrics: Record<string, Metrics> };
  readonly metrics: Metrics | null;
}

interface Reply {
  readonly model: string;
  readonly responseId?: string | null;
  readonly usage?: Record<string, unknown>;
  readonly tool?: 'think' | 'finish';
}

function providerFixture(replies: readonly Reply[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    agentFactory: () => new Agent({
      llm: new OpenAIChatClient(llmProfileSchema.parse({ profileId: 'metrics', providerId: 'openrouter', model: 'requested-model', openAiApiMode: 'chat_completions' }), 'fixture-key', async () => {
        const reply = replies[calls++];
        if (reply === undefined) throw new Error('Unexpected extra provider call');
        const tool = reply.tool ?? 'finish';
        const body = {
          // Repeated provider response IDs must not hide distinct paid requests.
          ...(reply.responseId === null ? {} : { id: reply.responseId ?? 'provider-reuses-this-id' }),
          model: reply.model,
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: tool, arguments: JSON.stringify(tool === 'think' ? { thought: 'one thought' } : { message: 'done' }) } }] } }],
          ...(reply.usage === undefined ? {} : { usage: reply.usage }),
        };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }),
      tools: [ThinkTool.create(), FinishTool.create()],
    }),
  };
}

const firstUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.01 };
const secondUsage = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 4 }, cost: 0.02 };

async function readInfo(server: AgentServerApp, id: string): Promise<Info> {
  const response = await server.app.inject({ method: 'GET', url: `/api/conversations/${id}` });
  expect(response.statusCode).toBe(200);
  return response.json<Info>();
}

async function finishRun(server: AgentServerApp, id: string, eventId?: string): Promise<Info> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('finish')], run: true, ...(eventId === undefined ? {} : { event_id: eventId }) } });
  expect(response.statusCode).toBe(200);
  await expect.poll(async () => (await readInfo(server, id)).execution_status).toBe('finished');
  return readInfo(server, id);
}

async function start(server: AgentServerApp): Promise<string> {
  const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(response.statusCode).toBe(201);
  return response.json<Info>().id;
}

function records(info: Info) {
  return Object.values(info.stats.usage_to_metrics).flatMap((metrics) => metrics.token_usages ?? []);
}

describe('provider accounting over the agent-server boundary', () => {
  test('records each paid response once, exposes totals, and resumes accounting after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-metrics-'));
    const fixture = providerFixture([{ model: 'model-one', usage: firstUsage, tool: 'think' }, { model: 'model-one', usage: secondUsage }, { model: 'model-two', usage: firstUsage }]);
    const options = { agentFactory: fixture.agentFactory, config: { conversationsPath: root, statePath: path.join(root, 'state') }, secretStore: new InMemorySecretStore() };
    let server = await createAgentServerApp(options);
    try {
      const id = await start(server);
      const emitted: Event[] = [];
      const service = await server.conversationService.getEventService(id);
      await service!.subscribeToEvents((event) => { emitted.push(event); });
      const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const first = await finishRun(server, id, eventId);
      expect(fixture.calls).toBe(2);
      expect(first.metrics?.accumulated_token_usage).toMatchObject({ prompt_tokens: 300, completion_tokens: 30, cache_read_tokens: 160, reasoning_tokens: 6 });
      expect(first.metrics?.accumulated_cost).toBeNull();
      expect(first.metrics?.known_costs.credits).toBeCloseTo(0.03);
      expect(records(first)).toHaveLength(2);
      expect(records(first).map((record) => record.model)).toEqual(['model-one', 'model-one']);
      await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage').length).toBe(2);
      await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state').at(-1)).toMatchObject({ value: { stats: first.stats } });

      const repeated = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('finish')], run: false, event_id: eventId } });
      expect(repeated.json()).toMatchObject({ created: false });
      expect((await readInfo(server, id)).stats).toEqual(first.stats);
      expect(fixture.calls).toBe(2);

      await server.app.close();
      server = await createAgentServerApp(options);
      expect((await readInfo(server, id)).stats).toEqual(first.stats);
      const resumed = await finishRun(server, id);
      expect(fixture.calls).toBe(3);
      expect(resumed.metrics?.accumulated_token_usage).toMatchObject({ prompt_tokens: 400, completion_tokens: 40, cache_read_tokens: 220, reasoning_tokens: 8 });
      expect(resumed.metrics?.accumulated_cost).toBeNull();
      expect(resumed.metrics?.known_costs.credits).toBeCloseTo(0.04);
      expect(records(resumed)).toHaveLength(3);
      expect(records(resumed).map((record) => record.model)).toEqual(['model-one', 'model-one', 'model-two']);
      const search = await server.app.inject({ method: 'GET', url: '/api/conversations/search' });
      expect(search.json<{ items: Info[] }>().items.find((item) => item.id === id)?.metrics).toEqual(resumed.metrics);
    } finally {
      await server.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('forks reset metrics by default and preserve them only when requested, across restart', async () => {
    // Adapted from pinned tests/sdk/conversation/local/test_fork.py metrics cases.
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-metrics-fork-'));
    const fixture = providerFixture([{ model: 'model-one', usage: firstUsage }, { model: 'model-one', usage: secondUsage }]);
    const options = { agentFactory: fixture.agentFactory, config: { conversationsPath: root, statePath: path.join(root, 'state') }, secretStore: new InMemorySecretStore() };
    let server = await createAgentServerApp(options);
    try {
      const id = await start(server);
      const source = await finishRun(server, id);
      const resetResponse = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, payload: {} });
      const retainedResponse = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, payload: { reset_metrics: false } });
      expect(resetResponse.statusCode).toBe(201);
      expect(retainedResponse.statusCode).toBe(201);
      const reset = resetResponse.json<Info>();
      const retained = retainedResponse.json<Info>();
      expect(records(reset)).toHaveLength(0);
      expect(reset.metrics?.accumulated_cost).toBe(0);
      expect(retained.stats).toEqual(source.stats);
      await server.app.close();
      server = await createAgentServerApp(options);
      expect((await readInfo(server, reset.id)).stats).toEqual(reset.stats);
      expect((await readInfo(server, retained.id)).stats).toEqual(source.stats);
      const continued = await finishRun(server, reset.id);
      expect(records(continued)).toHaveLength(1);
      expect(continued.metrics?.accumulated_cost).toBeNull();
      expect(continued.metrics?.known_costs.credits).toBeCloseTo(0.02);
      expect(continued.metrics?.accumulated_token_usage?.prompt_tokens).toBe(200);
      expect((await readInfo(server, id)).stats).toEqual(source.stats);
      expect((await readInfo(server, retained.id)).stats).toEqual(source.stats);
    } finally {
      await server.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps unreported tokens and cost unknown rather than fabricating zero usage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-metrics-missing-'));
    const fixture = providerFixture([{ model: 'model-one', responseId: null }]);
    const server = await createAgentServerApp({ agentFactory: fixture.agentFactory, config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
    try {
      const id = await start(server);
      const info = await finishRun(server, id);
      expect(info.metrics).not.toBeNull();
      expect(info.metrics?.accumulated_cost).toBeNull();
      expect(info.metrics?.accumulated_token_usage?.prompt_tokens).toBeNull();
      expect(info.metrics?.coverage.unmeasured_history).toBe(false);
      expect(records(info)).toHaveLength(1);
      expect(fixture.calls).toBe(1);
    } finally {
      await server.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('old event history with no usage records is not reported as a fully measured zero-cost conversation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-metrics-legacy-'));
    const server = await createAgentServerApp({ agentFactory: providerFixture([]).agentFactory, config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
    try {
      const id = await start(server);
      const service = await server.conversationService.getEventService(id);
      await service!.state.appendEventAsync(messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: [textContent('Historical response whose usage was never recorded.')] } }));
      const info = await readInfo(server, id);
      expect(info.metrics).not.toBeNull();
      expect(info.metrics?.accumulated_cost).toBeNull();
      expect(info.metrics?.accumulated_token_usage?.prompt_tokens).toBeNull();
      expect(info.metrics?.coverage.unmeasured_history).toBe(true);
    } finally {
      await server.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
