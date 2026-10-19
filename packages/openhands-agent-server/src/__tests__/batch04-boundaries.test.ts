import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { InMemorySecretStore, getSupportedLLMModels, type OpenAISubscriptionAuth } from '@smolpaws/openhands-agent';
import { createAgentServerApp } from '../app.js';
import { registerLlmRoutes } from '../llmRouter.js';
import { publicStartConversationRequestSchema } from '../models.js';

async function fixture(sessionApiKey: string | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'server04-boundary-'));
  const store = new InMemorySecretStore();
  const set = vi.spyOn(store, 'set');
  const server = await createAgentServerApp({ secretStore: store,
    config: { workspaceRoot: root, statePath: join(root, 'state'), conversationsPath: join(root, 'conversations'), bashEventsPath: join(root, 'bash'), sessionApiKey },
  });
  return { ...server, root, set, async close() { await server.app.close(); await rm(root, { recursive: true, force: true }); } };
}

it('rejects unusable secrets before mutation and preserves accepted bytes verbatim', async () => {
  const f = await fixture();
  try {
    const valid = '  token with spaces  ';
    const put = (value: string) => f.app.inject({ method: 'PUT', url: '/api/settings/secrets', payload: { name: 'TOKEN', value } });
    expect((await put(valid)).statusCode).toBe(200);
    const original = await f.serverStateService.getSecretMetadata('TOKEN');
    expect(await f.serverStateService.resolveSecret('TOKEN')).toBe(valid);
    f.set.mockClear();
    for (const value of ['', ' \t\n', '**********']) {
      const result = await put(value);
      expect(result.statusCode).toBe(422);
      expect(result.json().detail).toBe('Secret value must not be empty or redacted');
    }
    expect(f.set).not.toHaveBeenCalled();
    expect(await f.serverStateService.getSecretMetadata('TOKEN')).toEqual(original);
    expect(JSON.stringify(await readFile(join(f.root, 'state', 'state.json'), 'utf8'))).not.toContain(valid);
  } finally { await f.close(); }
});

it('maps directory and non-directory ancestor uploads to400 through both route shapes', async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, 'target'); const file = join(f.root, 'file');
    await mkdir(directory); await writeFile(file, 'original');
    for (const target of [directory, join(file, 'child')]) for (const url of [`/api/file/upload?path=${encodeURIComponent(target)}`, `/api/file/upload${target}`]) {
      const result = await f.app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: 'replacement' });
      expect(result.statusCode).toBe(400);
    }
    expect(await readFile(file, 'utf8')).toBe('original');
  } finally { await f.close(); }
});

it('keeps empty scalar auth disabled and nonempty auth enforced', async () => {
  for (const value of ['', 'required']) {
    const f = await fixture(value);
    try { expect((await f.app.inject('/api/settings')).statusCode).toBe(value ? 401 : 200); }
    finally { await f.close(); }
  }
});

it('consumes the SDK supported-model union and reports refresh transport failures disconnected', async () => {
  const auth = { refreshIfNeeded: vi.fn(async () => { throw new Error('private-transport-detail'); }), getCredentials: vi.fn() } as unknown as OpenAISubscriptionAuth;
  const app = Fastify(); registerLlmRoutes(app, auth);
  try {
    expect((await app.inject('/api/llm/models')).json().models).toEqual([...new Set(getSupportedLLMModels())].sort());
    expect((await app.inject('/api/llm/subscription/openai/models')).json().models).toEqual(expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna']));
    const result = await app.inject('/api/llm/subscription/openai/status');
    expect(result.json().connected).toBe(false); expect(result.body).not.toContain('private-transport-detail');
  } finally { await app.close(); }
});

it('accepts SDK launch additions and rejects overrides without a stored profile or inline profiles', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const additions = { llm_profile_ref: 'override', skills: [{ name: 'extra', content: 'data', trigger: null }] };
  expect(publicStartConversationRequestSchema.parse({ agent_profile_id: id, agent_launch_additions: additions }).agent_launch_additions).toMatchObject(additions);
  expect(() => publicStartConversationRequestSchema.parse({ agent_launch_additions: additions })).toThrow();
  expect(() => publicStartConversationRequestSchema.parse({ agent_profile: { name: 'inline' } })).toThrow();
});
