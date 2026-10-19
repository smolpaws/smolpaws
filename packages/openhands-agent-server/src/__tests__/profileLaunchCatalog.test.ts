import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, llmProfileSchema, skillSchema, type Skill } from '@smolpaws/openhands-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerStateService } from '../serverState.js';
import { prepareServerStartRequest, resolvePreparedLaunch, restoreResolvedLaunch, serverLaunchStores } from '../launch.js';
import { createProfileAgentFactory } from '../profileAgentFactory.js';
import type { StartConversationRequest, StoredConversation } from '../models.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const skill = (name: string, content = name): Skill => skillSchema.parse({ name, content });
const draft = (extra: Record<string, unknown> = {}) => ({ name: 'worker', llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, ...extra });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-launch-catalog-')); roots.push(root);
  const secretStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: root, secretStore });
  for (const name of ['main', 'override', 'summary', 'classifier']) await state.saveProfile(llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: `${name}-before` }));
  return { root, state, secretStore };
}
function stored(request: StartConversationRequest, root: string): StoredConversation {
  return { id: randomUUID(), request: { ...request, persistence_dir: join(root, 'conversations') }, workspace: { kind: 'LocalWorkspace', working_dir: root },
    title: null, tags: {}, secret_names: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
}

it.each([
  [null, ['public', 'shadow', 'local']],
  [[], ['shadow', 'local']],
  [['public'], ['public', 'shadow', 'local']],
] as const)('captures one coherent catalog and applies public selection %j only to public winners', async (selection, expected) => {
  const { state } = await fixture();
  const snapshot = { skills: [skill('public'), skill('shadow', 'user wins public collision'), skill('local')], publicSkillNames: ['public'] };
  const profileCatalog = vi.fn(async () => snapshot);
  const profile = await state.saveAgentProfile(draft({ public_skills: selection }));
  const request = await prepareServerStartRequest({ agent_profile_id: profile.id }, state, { profileCatalog });
  expect(profileCatalog).toHaveBeenCalledOnce();
  expect(restoreResolvedLaunch(request)!.context?.skills?.map(value => value.name)).toEqual(expected);
  snapshot.skills.splice(0); snapshot.publicSkillNames.push('shadow');
  const restored = restoreResolvedLaunch(JSON.parse(JSON.stringify(request)) as StartConversationRequest)!;
  expect(restored.context?.skills?.map(value => value.name)).toEqual(expected);
});

it('binds both SDK callbacks to copies from the same catalog and sanitizes discovery errors', async () => {
  const { state } = await fixture();
  const source = { skills: [skill('one')], publicSkillNames: ['one'] };
  const stores = await serverLaunchStores(state, { profileCatalog: async () => source });
  expect((await stores.skills!()).map(value => value.name)).toEqual(['one']);
  source.skills.splice(0); source.publicSkillNames.splice(0);
  expect((await stores.skills!()).map(value => value.name)).toEqual(['one']);
  expect(await stores.publicSkillNames!()).toEqual(['one']);
  const failed = await serverLaunchStores(state, { profileCatalog: async () => { throw new Error('private-url-token'); } });
  await expect(failed.skills!()).rejects.toThrow('Could not load launch skill catalog');
});

it('plain settings launches do not depend on an unused profile catalog', async () => {
  const { state } = await fixture();
  const profileCatalog = vi.fn(async () => { throw new Error('private-catalog-failure'); });
  const request = await prepareServerStartRequest({ agent: { llm_profile_ref: 'main', tools: [], condenser: { enabled: false } } }, state, { profileCatalog });
  expect(restoreResolvedLaunch(request)!.bindings.main?.profileId).toBe('main');
  expect(profileCatalog).not.toHaveBeenCalled();
});

it('overrides only the main role and records provenance without mutating stored profiles or auxiliary bindings', async () => {
  const { state } = await fixture();
  await state.saveMetaProfile('routing', { classifier_model: 'classifier', classes: [{ description: 'work', model: 'main' }] });
  const original = await state.saveAgentProfile(draft({ condenser: { enabled: true, llm_profile_ref: 'summary', max_tokens: null },
    enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'routing' }));
  const request = await prepareServerStartRequest({ agent_profile_id: original.id, agent_launch_additions: { llm_profile_ref: 'override' } }, state);
  const resolved = restoreResolvedLaunch(request)!;
  expect(resolved.settings.llm_profile_ref).toBe('override');
  expect(resolved.bindings.main?.profileId).toBe('override');
  expect(resolved.bindings.condenser?.profileId).toBe('summary');
  expect(resolved.settings.meta_profile_llms.classifier?.profileId).toBe('classifier');
  expect(resolved.settings.meta_profile_llms.main?.profileId).toBe('main');
  expect(resolved.profile).toMatchObject({ agent_profile_id: original.id, revision: original.revision, llm_profile_ref: 'override' });
  expect(await state.getAgentProfile('worker')).toEqual(original);
  await expect(prepareServerStartRequest({ agent_profile_id: original.id, agent_launch_additions: { llm_profile_ref: 'missing' } }, state)).rejects.toMatchObject({ llmProfileRef: 'missing' });
});

it('preserves override, skills, and provenance while completing only a staged condenser role', async () => {
  const { state } = await fixture();
  const original = await state.saveAgentProfile(draft({ condenser: { enabled: true }, public_skills: ['public'] }));
  const profileCatalog = vi.fn(async () => ({ skills: [skill('public', 'captured')], publicSkillNames: ['public'] }));
  const prepared = await prepareServerStartRequest({ agent_profile_id: original.id, agent_launch_additions: { llm_profile_ref: 'override' } }, state,
    { profileCatalog, deferCondenserResolution: true });
  await state.saveAgentProfile(draft({ persona: 'later' }));
  await state.saveProfile(llmProfileSchema.parse({ profileId: 'override', providerId: 'openai', model: 'override-later' }));
  const completed = await resolvePreparedLaunch(prepared, state, { defaultCondenserProfileRef: 'summary' });
  const resolved = restoreResolvedLaunch(completed)!;
  expect(resolved.bindings.main?.model).toBe('override-before');
  expect(resolved.bindings.condenser?.profileId).toBe('summary');
  expect(resolved.context?.skills?.[0]?.content).toBe('captured');
  expect(resolved.profile?.llm_profile_ref).toBe('override');
  expect(profileCatalog).toHaveBeenCalledOnce();
});

it('factory finalization adds skills once, keeps first names and denylist, and restores from captured context', async () => {
  const { root, state, secretStore } = await fixture();
  const profile = await state.saveAgentProfile(draft({ disabled_skills: ['blocked'], public_skills: [], system_message_suffix: 'saved' }));
  const request = await prepareServerStartRequest({ agent_profile_id: profile.id, agent_launch_additions: {
    system_message_suffix_append: 'appended', skills: [skill('local', 'must not replace'), skill('added', 'first'), skill('added', 'second'), skill('blocked')] } }, state,
  { profileCatalog: async () => ({ skills: [skill('local', 'captured'), skill('public')], publicSkillNames: ['public'] }) });
  await state.deleteAgentProfile('worker');
  const factory = createProfileAgentFactory({ state, secretStore, llmClientFactory: async profile => ({ profile, async complete() { throw new Error('must not complete'); } }) });
  const first = await factory(request.agent, { stored: stored(request, root) });
  const replay = await factory(request.agent, { stored: stored(JSON.parse(JSON.stringify(request)) as StartConversationRequest, root) });
  for (const agent of [first, replay]) {
    expect(agent.context?.skills.map(value => [value.name, value.content])).toEqual([['local', 'captured'], ['added', 'first']]);
    expect(agent.context?.systemMessageSuffix).toBe('saved\n\nappended');
  }
});
