import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, llmProfileSchema, messageSchema, validateAgentSettings, type LLMClient } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createProfileAgentFactory } from '../profileAgentFactory.js';
import { publicStartConversationRequestSchema, startConversationRequestSchema, type StoredConversation } from '../models.js';
import { ServerStateService } from '../serverState.js';
import type { AgentFactoryContext } from '../eventService.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(condenser: unknown = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'condenser-profile-')); roots.push(root);
  const secretStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: root, secretStore });
  const profiles = ['main', 'other', 'summary', 'explicit'].map(profileId => llmProfileSchema.parse({ profileId, providerId: 'openai', model: `model-${profileId}` }));
  for (const profile of profiles) await state.saveProfile(profile);
  const request = startConversationRequestSchema.parse({ id: randomUUID(), agent: { llm_profile_ref: 'main', tools: ['finish'], condenser }, llm_profile_snapshot: profiles[0] });
  const stored: StoredConversation = { id: request.id!, request, workspace: request.workspace, title: null, tags: {}, secret_names: [], created_at: '2026-01-01', updated_at: '2026-01-01' };
  let limit = 900;
  const complete = vi.fn(async () => ({ message: messageSchema.parse({ role: 'assistant', content: 'summary' }), usage: null }));
  const createClient = vi.fn(async (profile): Promise<LLMClient> => ({ profile, effectiveMaxInputTokens: limit, complete }));
  const select = vi.fn(async () => 'summary' as string | undefined);
  const updateRequest = vi.fn<NonNullable<AgentFactoryContext['updateRequest']>>(async update => { stored.request = startConversationRequestSchema.parse(update(stored.request)); });
  const factory = createProfileAgentFactory({ state, secretStore, llmClientFactory: createClient, resolveCondenserProfileSelection: select });
  const build = () => factory(stored.request.agent, { stored, updateRequest });
  return { state, stored, createClient, complete, select, updateRequest, factory, build, setLimit: (value: number) => { limit = value; } };
}

test('explicit condenser ref wins over role selection and uses an independent client', async () => {
  const f = await fixture({ llm_profile_ref: 'explicit' });
  const agent = await f.build();
  expect(f.select).not.toHaveBeenCalled();
  expect(agent.llm.profile.profileId).toBe('main');
  expect(agent.condenser).toMatchObject({ llm: { profile: { profileId: 'explicit' } }, maxTokens: 900, maxSize: 1000, keepFirst: 2 });
  expect(f.stored.request.condenser_binding).toMatchObject({ profile: { profileId: 'explicit' }, settings: { llm_profile_ref: 'explicit', max_tokens: 900 } });
  expect(f.complete).not.toHaveBeenCalled();
});

test.each([{ enabled: false }, { condenser_kind: 'no_op' }])('disabled/noop condenser does no role/catalog/client lookup: %j', async condenser => {
  const f = await fixture(condenser);
  const lookup = vi.spyOn(f.state, 'getProfile');
  f.select.mockRejectedValue(new Error('configuration must not be read'));
  const agent = await f.build();
  expect(f.select).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).toEqual(['main']);
  expect(f.updateRequest).not.toHaveBeenCalled();
  expect(f.stored.request.condenser_binding).toBeUndefined();
  if ('enabled' in condenser) expect(agent.condenser).toBeNull();
  else expect(agent.condenser?.handlesCondensationRequests?.()).toBe(false);
});

test('enabled missing ref/role fails with a clear error and never borrows the main client', async () => {
  const f = await fixture(); f.select.mockResolvedValue(undefined);
  await expect(f.build()).rejects.toThrow(/condenser.*(profile|reference)/i);
  expect(f.stored.request.condenser_binding).toBeUndefined();
  expect(f.complete).not.toHaveBeenCalled();
});

test('a missing explicitly selected profile does not fall back to a role', async () => {
  const f = await fixture({ llm_profile_ref: 'missing' });
  await expect(f.build()).rejects.toThrow(/condenser.*not_found/);
  expect(f.select).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
});

test.each([[undefined, 900], [null, null], [400, 400]])('freezes resolved token cap while preserving initial %s semantics', async (maxTokens, expected) => {
  const f = await fixture(maxTokens === undefined ? {} : { max_tokens: maxTokens });
  await f.build();
  expect(f.stored.request.condenser_binding).toMatchObject({ settings: { max_tokens: expected } });
  f.stored.request = startConversationRequestSchema.parse(JSON.parse(JSON.stringify(f.stored.request)));
  f.setLimit(4000); f.select.mockRejectedValue(new Error('role config was removed'));
  await f.state.deleteProfile('summary');
  const restored = await f.build();
  expect(restored.condenser).toMatchObject({ maxTokens: expected, llm: { profile: { profileId: 'summary', model: 'model-summary' } } });
  expect(f.select).toHaveBeenCalledOnce();
});

test('binding survives a main profile switch and a copied fork request', async () => {
  const f = await fixture(); await f.build();
  const before = JSON.stringify(f.stored.request.condenser_binding);
  const other = await f.state.getProfile('other');
  f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent: { ...validateAgentSettings(f.stored.request.agent), llm_profile_ref: 'other' }, llm_profile_snapshot: other });
  f.select.mockResolvedValue('explicit');
  const switched = await f.build();
  expect(switched.llm.profile.profileId).toBe('other');
  expect(switched.condenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
  const fork = { ...f.stored, id: randomUUID(), request: startConversationRequestSchema.parse(JSON.parse(JSON.stringify(f.stored.request))) };
  const agent = await f.factory(fork.request.agent, { stored: fork });
  expect(agent.condenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
  expect(JSON.stringify(fork.request.condenser_binding)).toBe(before);
});

test('ownership/persistence failure does not publish or use a candidate binding', async () => {
  const f = await fixture();
  f.updateRequest.mockRejectedValue(new Error('ownership lost'));
  await expect(f.build()).rejects.toThrow('ownership lost');
  expect(f.stored.request.condenser_binding).toBeUndefined();
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).not.toContain('summary');
});

test('a concurrently captured binding wins the guarded compare-and-set', async () => {
  const f = await fixture();
  await f.build();
  const accepted = f.stored.request.condenser_binding;
  delete f.stored.request.condenser_binding;
  f.select.mockResolvedValue('explicit');
  f.updateRequest.mockImplementation(async update => {
    f.stored.request = startConversationRequestSchema.parse(update({ ...f.stored.request, condenser_binding: accepted }));
  });
  const agent = await f.build();
  expect(agent.condenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
});

test('public creation strips forged condenser bindings', async () => {
  const f = await fixture(); await f.build();
  const publicRequest = publicStartConversationRequestSchema.parse({ agent: { llm_profile_ref: 'main' }, condenser_binding: f.stored.request.condenser_binding });
  expect(publicRequest).not.toHaveProperty('condenser_binding');
});

test('a changed condenser setting during resolution cannot publish a stale binding', async () => {
  const f = await fixture();
  f.select.mockImplementation(async () => {
    f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request,
      agent: { ...validateAgentSettings(f.stored.request.agent), condenser: { llm_profile_ref: 'explicit' } },
    });
    return 'summary';
  });
  await expect(f.build()).rejects.toThrow('condenser_configuration_changed_during_capture');
  expect(f.stored.request.condenser_binding).toBeUndefined();
  expect(f.complete).not.toHaveBeenCalled();
  expect((await f.build()).condenser).toMatchObject({ llm: { profile: { profileId: 'explicit' } } });
});

test('a committed binding survives guarded cleanup failure without another summary attempt', async () => {
  const f = await fixture();
  f.updateRequest.mockImplementation(async update => {
    f.stored.request = startConversationRequestSchema.parse(update(f.stored.request));
    throw new Error('lease cleanup failed');
  });
  await expect(f.build()).rejects.toThrow('lease cleanup failed');
  expect(f.complete).not.toHaveBeenCalled();
  f.select.mockResolvedValue('explicit');
  expect((await f.build()).condenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
  expect(f.select).toHaveBeenCalledOnce();
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId).filter(id => id === 'summary')).toHaveLength(1);
});


test.each([undefined, null])('legacy %s agent fallback cannot overwrite an agent supplied during capture', async missingAgent => {
  const f = await fixture();
  await f.state.updateSettings({ agent_settings: { llm_profile_ref: 'main', tools: ['finish'] } });
  f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent: missingAgent });
  f.select.mockImplementation(async () => {
    f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent: { llm_profile_ref: 'other', tools: ['finish'] } });
    return 'summary';
  });
  await expect(f.build()).rejects.toThrow('condenser_configuration_changed_during_capture');
  expect(f.stored.request.condenser_binding).toBeUndefined();
  expect(f.stored.request.agent).toMatchObject({ llm_profile_ref: 'other' });
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).not.toContain('summary');
});
