import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Agent, InMemorySecretStore, OpenAISubscriptionAuth, VERIFIED_MODELS, llmProfileSchema, messageSchema } from '@smolpaws/openhands-agent';
import { registerLlmRoutes } from '../llmRouter.js';
import { generateOpenApiSchema } from '../openapi.js';
import { createAgentServerApp } from '../app.js';

// Exact new source regression: test_list_models_filtered_by_openrouter_provider.
it('lists OpenRouter routes without leaking namespaced direct-provider collisions', async () => {
  const app = Fastify(); registerLlmRoutes(app, new OpenAISubscriptionAuth());
  try {
    const result = await app.inject('/api/llm/models?provider=openrouter');
    expect(result.statusCode).toBe(200);
    const models = result.json<{ models: string[] }>().models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(model => model.startsWith('openrouter/'))).toBe(true);
    expect(models).toContain('openrouter/deepseek/deepseek-chat');
    for (const collision of ['deepseek/deepseek-chat', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash']) expect(models).not.toContain(collision);
    // Verified inventory remains the exact provider-relative oracle, not a route list.
    expect((await app.inject('/api/llm/models/verified')).json().models.openrouter).toEqual(VERIFIED_MODELS.openrouter);
    expect((await app.inject('/api/llm/providers')).json().providers).toContain('openrouter');
    expect((await app.inject('/api/llm/models')).json().models).toContain('openrouter/deepseek/deepseek-chat');
  } finally { await app.close(); }
});

it('documents observability headers as optional headers and preserves nullable request schemas', () => {
  const paths = generateOpenApiSchema().paths as Record<string, { post: { parameters: Array<{ name: string; in: string; required: boolean }>; requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown>; required?: string[] } } } } } }>;
  const operation = paths['/api/conversations']!.post;
  const headers = operation.parameters.filter(parameter => parameter.name.startsWith('X-OpenHands-Observability-'));
  expect(headers).toHaveLength(4); expect(headers.every(header => header.in === 'header' && !header.required)).toBe(true);
  const body = operation.requestBody.content['application/json'].schema;
  for (const field of ['user_id', 'observability_metadata', 'observability_tags', 'observability_span_name', 'observability_parent_span_context']) {
    expect(body.properties).toHaveProperty(field); expect(body.required ?? []).not.toContain(field);
  }
});

it('rejects invalid observability before profile reads, credential writes or conversation creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observability-review-'));
  const secrets = new InMemorySecretStore(); const secretWrite = vi.spyOn(secrets, 'set');
  const { app, serverStateService, conversationService } = await createAgentServerApp({ secretStore: secrets,
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
  });
  const profileRead = vi.spyOn(serverStateService, 'getAgentProfileById');
  const settingsRead = vi.spyOn(serverStateService, 'launchSettings');
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/conversations',
      headers: { 'x-openhands-observability-metadata': '{"duplicate":{"private":"sentinel-secret"}}' },
      payload: { agent_profile_id: '11111111-1111-4111-8111-111111111111', observability_metadata: { duplicate: 'body-overrides' }, secrets: { TOKEN: 'sentinel-secret' } },
    });
    expect(invalid.statusCode).toBe(422); expect(invalid.body).not.toContain('sentinel-secret');
    expect(profileRead).not.toHaveBeenCalled(); expect(settingsRead).not.toHaveBeenCalled(); expect(secretWrite).not.toHaveBeenCalled();
    expect(await conversationService.countConversations()).toBe(0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

it('releases conversation ownership despite a throwing observability end hook and closes it only once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'span-close-review-'));
  const end = vi.fn(() => { throw new Error('private-exporter-error'); });
  const agentFactory = () => new Agent({ llm: { profile: llmProfileSchema.parse({ profileId: 'fixture', providerId: 'openai', model: 'fixture' }),
    complete: async () => ({ message: messageSchema.parse({ role: 'assistant', content: 'done' }), usage: null }) } });
  const options = { secretStore: new InMemorySecretStore(), agentFactory,
    observability: { env: { OTEL_ENDPOINT: 'fixture' }, spanFactory: () => ({ end }) },
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
  };
  let server = await createAgentServerApp(options);
  try {
    const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { initial_message: { content: 'hello' } } });
    expect(created.statusCode).toBe(201); const id = created.json<{ id: string }>().id;
    await (await server.conversationService.getEventService(id))!.whenIdle();
    await server.app.close(); await server.app.close(); expect(end).toHaveBeenCalledTimes(1);
    server = await createAgentServerApp(options);
    expect((await server.app.inject(`/api/conversations/${id}`)).statusCode).toBe(200);
    await server.app.close(); expect(end).toHaveBeenCalledTimes(1);
  } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
});
