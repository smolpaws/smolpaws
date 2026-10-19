import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { InMemorySecretStore, llmProfileSchema, llmProfileSecretRef } from '@smolpaws/openhands-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerStateService } from '../serverState.js';
import { registerAgentProfileRoutes } from '../agentProfilesRouter.js';
import { publicStartConversationRequestSchema } from '../models.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launch-profile-')); roots.push(root);
  const secrets = new InMemorySecretStore([[llmProfileSecretRef('main'), 'fixture-key']]);
  const state = new ServerStateService({ stateDir: root, secretStore: secrets });
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'gpt-4o', useProfileKeyOverride: true }));
  return { state, root, secrets };
}
const draft = (extra: Record<string, unknown> = {}) => ({ name: 'worker', llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, ...extra });

it('prepares immutable launch defaults without probing keychain availability', async () => {
  const { prepareServerStartRequest } = await import('../launch.js');
  const { state, secrets } = await fixture();
  vi.spyOn(secrets, 'has').mockRejectedValue(new Error('private-keychain-error'));
  const prepared = await prepareServerStartRequest({ agent: { llm_profile_ref: 'main', tools: [], condenser: { enabled: false } } }, state);
  expect(prepared.agent).toMatchObject({ llm_profile_ref: 'main' });
  expect(secrets.has).not.toHaveBeenCalled();
});

it('mints identity on create and preserves it with serialized revision increments on overwrite', async () => {
  const { state, root, secrets } = await fixture();
  const suppliedId = '11111111-1111-4111-8111-111111111111';
  const first = await state.saveAgentProfile(draft({ id: suppliedId, revision: 90 }));
  expect(first.id).not.toBe(suppliedId); expect(first.revision).toBe(90);
  const updates = await Promise.all([state.saveAgentProfile(draft({ id: suppliedId })), state.saveAgentProfile(draft({ id: suppliedId }))]);
  expect(updates.map(p => p.id)).toEqual([first.id, first.id]);
  expect(updates.map(p => p.revision)).toEqual([91, 92]);
  const restored = new ServerStateService({ stateDir: root, secretStore: secrets });
  expect(await restored.getAgentProfile('worker')).toMatchObject({ id: first.id, revision: 92 });
});

it('ACP settings never report an active native LLM credential as their own', async () => {
  const { state } = await fixture();
  await state.activateProfile('main');
  await state.updateSettings({ agent_settings: { agent_kind: 'acp' } });
  expect(await state.settings()).toMatchObject({ llm_api_key_set: false, agent_settings: { agent_kind: 'acp' } });
  await state.activateProfile('main');
  expect((await state.agentSettings())).not.toHaveProperty('llm_profile_ref');
});

it('rejects conflicting profile sources and strips all client supplied launch provenance', () => {
  expect(() => publicStartConversationRequestSchema.parse({ agent_profile_id: '11111111-1111-4111-8111-111111111111', agent: {} })).toThrow();
  const request = publicStartConversationRequestSchema.parse({ agent: {}, agent_settings: { invalid: true }, resolved_launch: { attacker: true }, launch_source: { attacker: true }, launched_agent_profile: { revision: 99 } });
  expect(request.agent_settings).toBeUndefined();
  expect(request).not.toHaveProperty('resolved_launch'); expect(request).not.toHaveProperty('launch_source'); expect(request).not.toHaveProperty('launched_agent_profile');
});

it('materializes a wrapped unsaved draft and rejects an unwrapped draft', async () => {
  const { state } = await fixture();
  const app = Fastify(); registerAgentProfileRoutes(app, state);
  try {
    const preview = await app.inject({ method: 'POST', url: '/api/agent-profiles/unsaved/materialize', payload: { profile: draft({ name: 'other' }) } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ valid: true, resolved_settings: { tools: [] } });
    expect(await state.getAgentProfile('unsaved')).toBeNull();
    const invalid = await app.inject({ method: 'POST', url: '/api/agent-profiles/unsaved/materialize', payload: draft() });
    expect(invalid.statusCode).toBe(422);
  } finally { await app.close(); }
});

it('distinguishes unavailable stored-profile reads from invalid materialize drafts without exposing errors', async () => {
  const { LaunchStoreError } = await import('@smolpaws/openhands-agent');
  const { state } = await fixture();
  const read = vi.spyOn(state, 'getAgentProfile');
  const app = Fastify(); registerAgentProfileRoutes(app, state);
  try {
    for (const [error, status] of [[new LaunchStoreError('private-store-detail', true), 503], [new LaunchStoreError('private-store-detail', false), 500], [new Error('private-store-detail'), 500]] as const) {
      read.mockRejectedValueOnce(error);
      const response = await app.inject({ method: 'POST', url: '/api/agent-profiles/worker/materialize' });
      expect(response.statusCode).toBe(status); expect(response.body).not.toContain('private-store-detail');
    }
    const invalid = await app.inject({ method: 'POST', url: '/api/agent-profiles/worker/materialize', payload: { profile: { schema_version: 9999 } } });
    expect(invalid.statusCode).toBe(422); expect(read).toHaveBeenCalledTimes(3);
  } finally { await app.close(); }
});

it('stages only a missing condenser role and keeps profile, context, meta and auxiliary snapshots fixed', async () => {
  const { prepareServerStartRequest, resolvePreparedLaunch, restoreResolvedLaunch } = await import('../launch.js');
  const { metaProfileSchema } = await import('@smolpaws/openhands-agent');
  const { state } = await fixture();
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'router', providerId: 'openai', model: 'router-before' }));
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'summary', providerId: 'openai', model: 'summary-selected' }));
  await state.saveMetaProfile('routing', metaProfileSchema.parse({ classifier_model: 'router', classes: [{ description: 'original', model: 'main' }] }));
  const profile = await state.saveAgentProfile(draft({ system_message_suffix: 'captured suffix', persona: 'captured persona',
    condenser: { enabled: true, max_tokens: null }, enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'routing', secret_refs: ['allowed'] }));
  const prepared = await prepareServerStartRequest({ agent_profile_id: profile.id, secrets: { allowed: 'fixture-one', denied: 'fixture-two' } }, state, { deferCondenserResolution: true });
  expect(prepared.launch_source).toEqual({ kind: 'missing_condenser_ref' });
  expect(prepared.agent).toMatchObject({ llm_profile_ref: 'main', condenser: { enabled: true } });
  expect(prepared.secrets).toEqual({ allowed: 'fixture-one' });
  await state.saveAgentProfile(draft({ system_message_suffix: 'changed suffix', persona: 'changed persona' }));
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'main-later' }));
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'router', providerId: 'openai', model: 'router-later' }));
  await state.saveMetaProfile('routing', metaProfileSchema.parse({ classifier_model: 'router', classes: [{ description: 'changed', model: 'main' }] }));
  const completed = await resolvePreparedLaunch(prepared, state, { defaultCondenserProfileRef: 'summary' });
  expect(completed).not.toHaveProperty('launch_source');
  const resolved = restoreResolvedLaunch(completed)!;
  expect(resolved.profile).toMatchObject({ agent_profile_id: profile.id, revision: 0 });
  expect(resolved.settings).toMatchObject({ persona: 'captured persona', condenser: { enabled: true, llm_profile_ref: 'summary', max_tokens: null },
    meta_profile: { classes: [{ description: 'original' }] } });
  expect(resolved.context?.systemMessageSuffix).toBe('captured suffix');
  expect(resolved.bindings.main?.model).toBe('gpt-4o');
  expect(resolved.bindings.condenser?.model).toBe('summary-selected');
  expect(resolved.settings.meta_profile_llms.router?.model).toBe('router-before');
  const restored = restoreResolvedLaunch(JSON.parse(JSON.stringify(completed)) as typeof completed)!;
  expect(restored.context?.systemMessageSuffix).toBe('captured suffix');
});

it('retains independent same-ID roles and overlays accepted main settings without rereading stores', async () => {
  const { prepareServerStartRequest, restoreResolvedLaunch } = await import('../launch.js');
  const { state } = await fixture();
  const request = await prepareServerStartRequest({ agent: { llm_profile_ref: 'main', tools: [], condenser: { llm_profile_ref: 'main', max_tokens: null } } }, state);
  const selected = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'new-main' });
  const restored = restoreResolvedLaunch({ ...request, llm_profile_snapshot: selected })!;
  expect(restored.bindings.main?.model).toBe('new-main');
  expect(restored.bindings.condenser?.model).toBe('gpt-4o');
});

it('preview reports dangling references and missing role selection without performing any completion', async () => {
  const { state } = await fixture();
  const app = Fastify(); registerAgentProfileRoutes(app, state);
  try {
    for (const profile of [draft({ llm_profile_ref: 'missing', mcp_server_refs: ['gone'] }), draft({ condenser: { enabled: true } })]) {
      const result = await app.inject({ method: 'POST', url: '/api/agent-profiles/preview/materialize', payload: { profile } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ valid: false, resolved_settings: null });
      expect(result.json<{ errors: string[] }>().errors.length).toBeGreaterThan(0);
    }
    const bad = await app.inject({ method: 'POST', url: '/api/agent-profiles/preview/materialize', payload: { profile: draft({ schema_version: 999, api_key: 'fixture-private' }) } });
    expect(bad.statusCode).toBe(422); expect(bad.body).not.toContain('fixture-private');
  } finally { await app.close(); }
});

it('copies tool provenance without granting generated identity to client tools', async () => {
  const { mergeToolModuleQualnames } = await import('../toolModuleProvenance.js');
  const caller = { terminal: 'caller.override', custom: 'caller.module' };
  const generated = { terminal: 'verified.module', client: 'must.not.be.generated', server: 'server.module' };
  const merged = mergeToolModuleQualnames(caller, generated, ['client']);
  expect(merged).toEqual({ terminal: 'caller.override', custom: 'caller.module', server: 'server.module' });
  merged.terminal = 'changed';
  expect(caller.terminal).toBe('caller.override'); expect(generated.terminal).toBe('verified.module');
});
