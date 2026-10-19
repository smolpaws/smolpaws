import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { getSupportedLLMModels, type OpenAISubscriptionAuth } from '@smolpaws/openhands-agent';
import { expect, it } from 'vitest';
import { registerLlmRoutes } from '../llmRouter.js';
import { MODEL_PROVIDER_NAMES_SOURCE } from '../llmProviderNames.js';

it('pins provider extraction namespaces to the canonical vendored source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../vendor/openhands-agent/transpile/upstream.json', import.meta.url), 'utf8')) as { commit: string };
  expect(MODEL_PROVIDER_NAMES_SOURCE.commit).toBe(manifest.commit);
});

// Pinned Python llm_router.list_models / _extract_model_and_provider oracle:
// provider prefixes may use dots, while a verified list never adds membership.
it('filters the supported catalog by conservative provider identity without inventing verified-only membership', async () => {
  const app = Fastify(); registerLlmRoutes(app, {} as OpenAISubscriptionAuth);
  try {
    const supported = new Set(getSupportedLLMModels());
    const openai = (await app.inject('/api/llm/models?provider=openai')).json<{ models: string[] }>().models;
    expect(openai).toContain('openai.gpt-oss-20b-1:0');
    expect(openai.every(model => supported.has(model))).toBe(true);
    const anthropic = (await app.inject('/api/llm/models?provider=anthropic')).json<{ models: string[] }>().models;
    expect(anthropic).toContain('anthropic.claude-3-haiku-20240307-v1:0');
    expect(anthropic.every(model => supported.has(model))).toBe(true);
    const openrouter = (await app.inject('/api/llm/models?provider=openrouter')).json<{ models: string[] }>().models;
    expect(openrouter).toContain('openrouter/deepseek/deepseek-chat');
    expect(openrouter).not.toContain('deepseek/deepseek-chat');
  } finally { await app.close(); }
});
