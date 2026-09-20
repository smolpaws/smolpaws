import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentResetCondenser, InMemorySecretStore, llmProfileSchema, messageSchema,
  validateAgentSettings, type LLMClient, type LLMProfile,
} from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createProfileAgentFactory } from '../profileAgentFactory.js';
import { publicStartConversationRequestSchema, startConversationRequestSchema, type StoredConversation } from '../models.js';
import { ConversationProfileRuntime } from '../profileRuntime.js';
import { ServerStateService } from '../serverState.js';
import type { AgentFactoryContext } from '../eventService.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const reset = { condenser_kind: 'agent_reset' };
const hard = { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary',
  hard_context_reset_max_retries: 2, hard_context_reset_context_scaling: 0.6 };

async function fixture(hardSettings: unknown = hard) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hard-condenser-profile-')); roots.push(root);
  const state = new ServerStateService({ stateDir: root, secretStore: new InMemorySecretStore() });
  const profiles = ['main', 'other', 'summary', 'explicit'].map(profileId => llmProfileSchema.parse({
    profileId, providerId: 'openai', model: `model-${profileId}`, maxInputTokens: profileId === 'main' ? 400_000 : 1_000_000,
  }));
  for (const profile of profiles) await state.saveProfile(profile);
  const agent = { llm_profile_ref: 'main', tools: ['finish'], condenser: reset,
    ...(hardSettings === undefined ? {} : { hard_condenser: hardSettings }) };
  const request = startConversationRequestSchema.parse({ id: randomUUID(), agent, llm_profile_snapshot: profiles[0] });
  const stored: StoredConversation = { id: request.id!, request, workspace: request.workspace, title: null,
    tags: {}, secret_names: [], created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' };
  const complete = vi.fn(async () => ({ message: messageSchema.parse({ role: 'assistant', content: 'fixture' }), usage: null }));
  const metadata = vi.fn(async () => undefined);
  const createClient = vi.fn(async (profile: LLMProfile): Promise<LLMClient> => ({
    profile, effectiveMaxInputTokens: 2_000_000, resolveRuntimeMetadata: metadata, complete,
  }));
  const select = vi.fn(async () => 'must-not-select');
  const updateRequest = vi.fn<NonNullable<AgentFactoryContext['updateRequest']>>(async update => {
    stored.request = startConversationRequestSchema.parse(update(stored.request));
  });
  const factory = createProfileAgentFactory({ state, secretStore: new InMemorySecretStore(),
    llmClientFactory: createClient, resolveCondenserProfileSelection: select });
  const build = () => factory(stored.request.agent, { stored, updateRequest });
  return { state, stored, createClient, complete, metadata, select, updateRequest, factory, build };
}

test.each(['omitted', 'null', 'disabled'] as const)('reset %s fallback needs no auxiliary profile, metadata or binding', async kind => {
  const f = await fixture(null);
  const agent = { llm_profile_ref: 'main', tools: ['finish'],
    condenser: { ...reset, ...(kind === 'disabled' ? { enabled: false } : {}) },
    ...(kind === 'null' ? { hard_condenser: null } : {}) };
  f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent });
  const lookup = vi.spyOn(f.state, 'getProfile');
  const result = await f.build();
  expect(result.hardCondenser).toBeNull();
  if (kind === 'disabled') expect(result.condenser).toBeNull();
  else expect(result.condenser).toBeInstanceOf(AgentResetCondenser);
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).toEqual(['main']);
  expect(lookup).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
  expect(f.metadata).not.toHaveBeenCalled();
  expect(f.updateRequest).not.toHaveBeenCalled();
  expect(f.stored.request).not.toHaveProperty('hard_condenser_binding');
  expect(f.stored.request).not.toHaveProperty('condenser_binding');
});

test('captures the explicit hard profile before constructing its client outside the guarded update', async () => {
  const f = await fixture();
  let inGuard = false;
  f.updateRequest.mockImplementation(async update => {
    inGuard = true;
    f.stored.request = startConversationRequestSchema.parse(update(f.stored.request));
    inGuard = false;
  });
  f.createClient.mockImplementation(async profile => {
    expect(inGuard).toBe(false);
    if (profile.profileId === 'summary') expect(f.stored.request.hard_condenser_binding).toMatchObject({ profile: { profileId: 'summary' }, settings: hard });
    return { profile, complete: f.complete };
  });
  const agent = await f.build();
  expect(agent.condenser).toBeInstanceOf(AgentResetCondenser);
  expect(agent.hardCondenser).toMatchObject({ llm: { profile: { profileId: 'summary' } },
    maxTokens: null, hardContextResetMaxRetries: 2, hardContextResetContextScaling: 0.6 });
  expect(agent.tools.filter(tool => tool.name === 'condense')).toHaveLength(1);
  expect(f.stored.request).not.toHaveProperty('condenser_binding');
  expect(f.stored.request.hard_condenser_binding?.settings).not.toHaveProperty('max_tokens');
  expect(f.select).not.toHaveBeenCalled();
  expect(f.metadata).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
});

test('catalog edits/deletion, JSON restore and a copied fork preserve the captured hard profile/settings', async () => {
  const f = await fixture();
  await f.build();
  const binding = structuredClone(f.stored.request.hard_condenser_binding);
  await f.state.saveProfile(llmProfileSchema.parse({ profileId: 'summary', providerId: 'openai', model: 'edited' }));
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { model: 'model-summary' } } });
  await f.state.deleteProfile('summary');
  f.stored.request = startConversationRequestSchema.parse(JSON.parse(JSON.stringify(f.stored.request)));
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { model: 'model-summary' } } });
  const fork = { ...f.stored, id: randomUUID(), request: startConversationRequestSchema.parse(JSON.parse(JSON.stringify(f.stored.request))) };
  expect((await f.factory(fork.request.agent, { stored: fork })).hardCondenser).toMatchObject({ llm: { profile: { model: 'model-summary' } } });
  expect(fork.request.hard_condenser_binding).toEqual(binding);
  expect(f.select).not.toHaveBeenCalled();
  expect(f.updateRequest).toHaveBeenCalledOnce();
});

test('main-profile activation preserves the same hard condenser and reset settings', async () => {
  const f = await fixture();
  const original = await f.build();
  const runtime = new ConversationProfileRuntime(f.stored, {
    getProfile: name => f.state.getProfile(name), createClient: f.createClient,
  }, f.updateRequest);
  await runtime.switchProfile('other');
  const replacement = await runtime.activate(original);
  expect(replacement).toBeDefined();
  expect(replacement).toMatchObject({ llm: { profile: { profileId: 'other', maxInputTokens: 1_000_000 } } });
  expect(replacement && replacement.hardCondenser).toBe(original.hardCondenser);
  expect(replacement && replacement.condenser).toBe(original.condenser);
  expect(replacement && replacement.tools.filter(tool => tool.name === 'condense')).toHaveLength(1);
  expect(f.stored.request.hard_condenser_binding).toMatchObject({ profile: { profileId: 'summary' } });
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
});

test('public creation strips a forged hard binding even when its payload is invalid', () => {
  const request = publicStartConversationRequestSchema.parse({ agent: { llm_profile_ref: 'main', condenser: reset },
    hard_condenser_binding: { profile: { profileId: 'forged' }, settings: { max_tokens: 1 } } });
  expect(request).not.toHaveProperty('hard_condenser_binding');
});

test.each(['mismatched-profile', 'cut-setting', 'extra-field'] as const)('internal binding rejects %s', async kind => {
  const f = await fixture(); await f.build();
  const binding = structuredClone(f.stored.request.hard_condenser_binding!);
  const invalid = kind === 'mismatched-profile' ? { ...binding, profile: { ...binding.profile, profileId: 'other' } }
    : kind === 'cut-setting' ? { ...binding, settings: { ...binding.settings, keep_first: 0 } }
    : { ...binding, raw_extra: true };
  expect(() => startConversationRequestSchema.parse({ ...f.stored.request, hard_condenser_binding: invalid })).toThrow();
});

test('a missing explicit hard profile never consults the ordinary role or borrows main', async () => {
  const f = await fixture({ ...hard, llm_profile_ref: 'missing' });
  await expect(f.build()).rejects.toThrow('hard_condenser_profile_not_found:missing');
  expect(f.select).not.toHaveBeenCalled();
  expect(f.stored.request).not.toHaveProperty('hard_condenser_binding');
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).toEqual(['main']);
  expect(f.complete).not.toHaveBeenCalled();
});

test('failed capture never constructs or uses the auxiliary client', async () => {
  const f = await fixture();
  f.updateRequest.mockRejectedValue(new Error('ownership lost'));
  await expect(f.build()).rejects.toThrow('ownership lost');
  expect(f.stored.request).not.toHaveProperty('hard_condenser_binding');
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).toEqual(['main']);
  expect(f.complete).not.toHaveBeenCalled();
});

test('configuration changes during profile lookup reject stale capture', async () => {
  const f = await fixture();
  const getProfile = f.state.getProfile.bind(f.state);
  vi.spyOn(f.state, 'getProfile').mockImplementationOnce(async name => {
    f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request,
      agent: { ...validateAgentSettings(f.stored.request.agent), hard_condenser: { ...hard, llm_profile_ref: 'explicit' } },
    });
    return getProfile(name);
  });
  await expect(f.build()).rejects.toThrow('hard_condenser_configuration_changed_during_capture');
  expect(f.stored.request).not.toHaveProperty('hard_condenser_binding');
  expect(f.createClient.mock.calls.map(([profile]) => profile.profileId)).toEqual(['main']);
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { profileId: 'explicit' } } });
});

test('a concurrently accepted binding wins without using a losing candidate profile', async () => {
  const f = await fixture(); await f.build();
  const accepted = f.stored.request.hard_condenser_binding;
  delete f.stored.request.hard_condenser_binding;
  await f.state.saveProfile(llmProfileSchema.parse({ profileId: 'summary', providerId: 'openai', model: 'losing-new-model' }));
  f.updateRequest.mockImplementation(async update => {
    f.stored.request = startConversationRequestSchema.parse(update({ ...f.stored.request, hard_condenser_binding: accepted }));
  });
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { profileId: 'summary', model: 'model-summary' } } });
  expect(f.createClient.mock.calls.some(([profile]) => profile.model === 'losing-new-model')).toBe(false);
});

test('a committed capture survives guard cleanup failure without another profile lookup', async () => {
  const f = await fixture();
  f.updateRequest.mockImplementation(async update => {
    f.stored.request = startConversationRequestSchema.parse(update(f.stored.request));
    throw new Error('guard cleanup failed');
  });
  await expect(f.build()).rejects.toThrow('guard cleanup failed');
  expect(f.stored.request.hard_condenser_binding).toMatchObject({ profile: { profileId: 'summary' } });
  const lookup = vi.spyOn(f.state, 'getProfile').mockRejectedValue(new Error('catalog unavailable'));
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { profileId: 'summary' } } });
  expect(lookup).not.toHaveBeenCalled();
  expect(f.createClient.mock.calls.filter(([profile]) => profile.profileId === 'summary')).toHaveLength(1);
  expect(f.complete).not.toHaveBeenCalled();
});

test.each([undefined, null])('legacy %s agent settings are pinned atomically with the hard binding', async missing => {
  const f = await fixture();
  const selected = f.stored.request.agent;
  await f.state.updateSettings({ agent_settings: selected as Record<string, unknown> });
  f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent: missing });
  const getProfile = f.state.getProfile.bind(f.state);
  vi.spyOn(f.state, 'getProfile').mockImplementationOnce(async name => {
    await f.state.updateSettings({ agent_settings: { llm_profile_ref: 'other', condenser: { enabled: false } } });
    return getProfile(name);
  });
  await f.build();
  expect(f.stored.request.agent).toMatchObject({ llm_profile_ref: 'main', condenser: reset, hard_condenser: hard });
  expect(f.stored.request.hard_condenser_binding).toMatchObject({ profile: { profileId: 'summary' } });
});

test('fallback client preparation failure retains the frozen binding without a paid call or main fallback', async () => {
  const f = await fixture();
  f.createClient.mockImplementation(async profile => {
    if (profile.profileId === 'summary') throw new Error('Fallback credentials unavailable');
    return { profile, complete: f.complete };
  });
  await expect(f.build()).rejects.toThrow('Fallback credentials unavailable');
  expect(f.stored.request.hard_condenser_binding).toMatchObject({
    profile: { profileId: 'summary', model: 'model-summary' }, settings: hard,
  });
  expect(f.complete).not.toHaveBeenCalled();
  await f.state.deleteProfile('summary');
  f.createClient.mockImplementation(async profile => ({ profile, complete: f.complete }));
  expect((await f.build()).hardCondenser).toMatchObject({ llm: { profile: { profileId: 'summary', model: 'model-summary' } } });
  expect(f.updateRequest).toHaveBeenCalledOnce();
  expect(f.select).not.toHaveBeenCalled();
});
