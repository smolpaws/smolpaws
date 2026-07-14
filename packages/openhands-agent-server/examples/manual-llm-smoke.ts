import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
  Agent,
  FinishTool,
  InMemorySecretStore,
  createClientFromProfile,
  llmProfileSecretRef,
  type LLMProfile,
} from '@smolpaws/openhands-agent';

import { createAgentServerApp } from '../src/app.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('Set OPENAI_API_KEY to run this manual smoke. The value is used only through an in-memory SecretStore and is never printed.');
}

const models = (process.env.OPENAI_MODELS ?? process.env.OPENAI_MODEL ?? 'gpt-5-nano,gpt-5-mini')
  .split(',')
  .map((model) => model.trim())
  .filter((model) => model.length > 0);

if (models.length === 0) throw new Error('OPENAI_MODELS did not contain any model names.');

const dummySecretValue = 'dummy-live-oh-secret-not-persisted';
const sessionApiKey = 'manual-smoke';

async function main(): Promise<void> {
  const results: SmokeResult[] = [];
  for (const model of models) {
    results.push(await runModelSmoke(model));
  }

  console.log(JSON.stringify({
    ok: true,
    models: results,
    agent_factory_profile_seam: 'The TypeScript server profile endpoints persist and activate profile metadata, but the current local createAgentServerApp seam still receives an injected agentFactory. This smoke therefore creates two distinct local LLM profiles, stores their API keys in an in-memory SecretStore, verifies the server profile endpoints for each profile, and starts a local server whose agentFactory is bound to the matching profile/model.',
  }, null, 2));
}

async function runModelSmoke(model: string): Promise<SmokeResult> {
  const profile = openAiProfile(model);
  const root = await mkdtemp(path.join(os.tmpdir(), `openhands-agent-server-live-${safeName(model)}-`));
  let server: Awaited<ReturnType<typeof createAgentServerApp>> | null = null;

  try {
    const conversationsPath = path.join(root, 'conversations');
    const workspaceRoot = path.join(root, 'workspace');
    const statePath = path.join(root, 'state');
    const secretStore = new InMemorySecretStore();
    await secretStore.set(llmProfileSecretRef(profile.profileId), apiKey);
    const llm = await createClientFromProfile(profile, secretStore);
    const agentFactory = () => new Agent({ llm, tools: [FinishTool.create()] });
    server = await createAgentServerApp({
      agentFactory,
      secretStore,
      config: { conversationsPath, workspaceRoot, statePath, sessionApiKey },
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new LocalClient(localHost(server.app.server.address()));

    const savedProfile = await client.postJson<{ profileId: string; model: string }>('/api/profiles', profile, 201);
    assertEqual(savedProfile.profileId, profile.profileId, `${model} saved profile id`);
    assertEqual(savedProfile.model, model, `${model} saved profile model`);
    const activation = await client.postJson<{ id: string }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/activate`, {});
    assertEqual(activation.id, profile.profileId, `${model} activated profile id`);

    const secretName = `OH_SECRET_${secretSafeName(model).toUpperCase()}`;
    await client.putJson('/api/settings/secrets', { name: secretName, value: dummySecretValue });
    const secretMetadata = await client.getJson<{ value: string }>(`/api/settings/secrets/${secretName}`);
    assertEqual(secretMetadata.value, '**********', `${model} settings secret masked`);

    const start = await client.postJson<{ id: string }>('/api/conversations', { max_iterations: 1 }, 201);
    await client.postJson(`/api/conversations/${start.id}/secrets`, { secrets: { LIVE_DUMMY: { value: dummySecretValue } } });
    await client.postJson(`/api/conversations/${start.id}/events`, {
      role: 'user',
      content: [{ type: 'text', text: `Reply with the exact text live-smoke-ok-${safeName(model)} and nothing else. Do not include the dummy secret value.` }],
      run: false,
    });
    await client.postJson(`/api/conversations/${start.id}/run`, {});
    const finalResponse = await waitForModelResponse(client, start.id, `live-smoke-ok-${safeName(model)}`);
    const plaintextPersisted = await pathContains(root, dummySecretValue);
    assertEqual(plaintextPersisted, false, `${model} dummy OH_SECRET plaintext persistence`);

    return {
      model,
      profile_id: profile.profileId,
      conversation_id: start.id,
      final_response: finalResponse,
      server_profile_endpoint_verified: true,
      direct_local_fetch_routes: true,
      remote_conversation_used: false,
      dummy_oh_secret_plaintext_persisted: false,
    };
  } finally {
    await server?.app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function openAiProfile(model: string): LLMProfile {
  return {
    profileId: `manual-smoke-openai-${safeName(model)}`,
    providerId: 'openai',
    model,
    baseUrl: null,
    openAiApiMode: 'responses',
    temperature: null,
    topP: null,
    topK: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    timeoutSeconds: 180,
    reasoningEffort: null,
    reasoningSummary: null,
    headers: {},
    useProfileKeyOverride: true,
  };
}

async function waitForModelResponse(client: LocalClient, conversationId: string, expectedSubstring: string): Promise<string> {
  let lastResponse = '';
  await waitFor(async () => {
    const info = await client.getJson<{ execution_status: string }>(`/api/conversations/${conversationId}`);
    if (info.execution_status === 'running' || info.execution_status === 'idle') throw new Error(`conversation ${conversationId} is still ${info.execution_status}`);
    const final = await client.getJson<{ response: string }>(`/api/conversations/${conversationId}/agent_final_response`);
    lastResponse = final.response;
    if (!final.response.includes(expectedSubstring)) throw new Error(`${conversationId} final response did not contain ${expectedSubstring}: ${final.response}`);
  }, 180_000);
  return lastResponse;
}

async function pathContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await pathContains(fullPath, needle)) return true;
    } else if (entry.isFile() && (await stat(fullPath)).size <= 1_000_000) {
      if ((await readFile(fullPath, 'utf8')).includes(needle)) return true;
    }
  }
  return false;
}

function localHost(address: string | AddressInfo | null): string {
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

class LocalClient {
  constructor(private readonly host: string) {}

  async getJson<T>(pathname: string, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('GET', pathname, undefined, expectedStatus);
  }

  async postJson<T = Record<string, never>>(pathname: string, body: unknown, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('POST', pathname, body, expectedStatus);
  }

  async putJson<T = Record<string, never>>(pathname: string, body: unknown, expectedStatus = 200): Promise<T> {
    return this.requestJson<T>('PUT', pathname, body, expectedStatus);
  }

  private async requestJson<T>(method: string, pathname: string, body: unknown, expectedStatus: number): Promise<T> {
    const response = await fetch(`${this.host}${pathname}`, {
      method,
      headers: { 'x-session-api-key': sessionApiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assertEqual(response.status, expectedStatus, `${method} ${pathname} status: ${text}`);
    return (text.length === 0 ? {} : JSON.parse(text)) as T;
  }
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase();
}

function secretSafeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

interface SmokeResult {
  readonly model: string;
  readonly profile_id: string;
  readonly conversation_id: string;
  readonly final_response: string;
  readonly server_profile_endpoint_verified: true;
  readonly direct_local_fetch_routes: true;
  readonly remote_conversation_used: false;
  readonly dummy_oh_secret_plaintext_persisted: false;
}

await main();
