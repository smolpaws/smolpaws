import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { InMemorySecretStore, defaultAgentSettings } from '@smolpaws/openhands-agent';
import { afterEach, expect, it } from 'vitest';
import { ServerStateService } from '../serverState.js';
import { registerAgentProfileRoutes } from '../agentProfilesRouter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'active-agent-profile-')); roots.push(root);
  const secretStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: root, secretStore });
  return { root, state, secretStore };
}
const draft = (name: string, extra: Record<string, unknown> = {}) => ({ name, llm_profile_ref: 'default', tools: [], condenser: { enabled: false }, ...extra });

it('concurrent first lists seed one default and atomically persist its pointer and identity', async () => {
  const { root, state, secretStore } = await fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => state.listAgentProfiles()));
  expect(responses[0]!.profiles).toHaveLength(1);
  const profile = responses[0]!.profiles[0]!;
  expect(profile.name).toBe('default');
  expect(responses.every(response => response.active_agent_profile_id === profile.id && response.profiles[0]!.id === profile.id)).toBe(true);
  const serialized = await readFile(join(root, 'state.json'), 'utf8');
  expect(JSON.parse(serialized)).toMatchObject({ settings: { active_agent_profile_id: profile.id }, agentProfiles: { default: { id: profile.id } } });
  const restored = new ServerStateService({ stateDir: root, secretStore });
  expect(await restored.listAgentProfiles()).toEqual(responses[0]);
  expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(serialized);
});

it('seeds current native fields and active LLM reference without credentials', async () => {
  const { state } = await fixture();
  await state.saveProfile({ ...(await state.getProfile('default'))!, profileId: 'selected' });
  await state.activateProfile('selected');
  await state.updateSettings({ agent_settings: { ...defaultAgentSettings('selected'), tools: [], persona: 'careful', tool_concurrency_limit: 3,
    condenser: { enabled: false, condenser_kind: 'no_op' }, enable_classify_and_switch_llm_tool: true, active_meta_profile: 'routing' } });
  expect((await state.listAgentProfiles()).profiles[0]).toMatchObject({ name: 'default', llm_profile_ref: 'selected', tools: [], persona: 'careful',
    tool_concurrency_limit: 3, condenser: { enabled: false }, meta_profile_ref: 'routing', public_skills: null });
});

it('seeds ACP metadata without switching the active LLM or executing it', async () => {
  const { state } = await fixture();
  await state.updateSettings({ agent_settings: { agent_kind: 'acp', acp_server: 'codex', acp_model: 'external' } });
  expect((await state.listAgentProfiles()).profiles[0]).toMatchObject({ agent_kind: 'acp', acp_server: 'codex', acp_model: 'external' });
  expect((await state.settings()).active_profile_id).toBe('default');
});

it('keeps a valid active profile and activates an existing default without overwriting it', async () => {
  const { state } = await fixture();
  const saved = await state.saveAgentProfile(draft('default', { persona: 'saved' }));
  expect((await state.listAgentProfiles()).active_agent_profile_id).toBe(saved.id);
  expect(await state.getAgentProfile('default')).toEqual(saved);
  const other = await state.saveAgentProfile(draft('other'));
  await state.activateAgentProfile(other.id);
  expect((await state.listAgentProfiles()).active_agent_profile_id).toBe(other.id);
});

it('repairs a dangling pointer and falls back alphabetically if 50 occupied names leave no room', async () => {
  const { state } = await fixture();
  await Promise.all(Array.from({ length: 50 }, (_, index) => state.saveAgentProfile(draft(`profile-${String(49 - index).padStart(2, '0')}`))));
  await state.updateSettings({ active_agent_profile_id: '11111111-1111-4111-8111-111111111111' });
  const result = await state.listAgentProfiles();
  expect(result.profiles).toHaveLength(50);
  expect(result.active_agent_profile_id).toBe(result.profiles[0]!.id);
  expect(result.profiles[0]!.name).toBe('profile-00');
  expect(await state.getAgentProfile('default')).toBeNull();
});

it('limits creates to 50 while concurrent same-name saves preserve identity and overwrites remain possible', async () => {
  const { state } = await fixture();
  const created = await Promise.all([state.saveAgentProfile(draft('same')), state.saveAgentProfile(draft('same'))]);
  expect(created[0]!.id).toBe(created[1]!.id); expect(created[1]!.revision).toBe(created[0]!.revision + 1);
  await Promise.all(Array.from({ length: 49 }, (_, index) => state.saveAgentProfile(draft(`p-${index}`))));
  const app = Fastify(); registerAgentProfileRoutes(app, state);
  try {
    const rejected = await app.inject({ method: 'POST', url: '/api/agent-profiles/overflow', payload: draft('overflow') });
    expect(rejected.statusCode).toBe(409);
    const updated = await app.inject({ method: 'POST', url: '/api/agent-profiles/same', payload: draft('same', { persona: 'new' }) });
    expect(updated.statusCode).toBe(201); expect(updated.json()).toMatchObject({ id: created[0]!.id });
  } finally { await app.close(); }
});

it.each([false, true])('keeps corrupt default untouched and selects a valid fallback only when present (%s)', async hasFallback => {
  const { root, state, secretStore } = await fixture();
  await state.updateSettings({});
  if (hasFallback) await state.saveAgentProfile(draft('mine'));
  const file = join(root, 'state.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const corrupt = { malformed: true, nested: { preserve: 'not a profile' } };
  data.agentProfiles.default = corrupt;
  await writeFile(file, JSON.stringify(data));
  const restored = new ServerStateService({ stateDir: root, secretStore });
  const result = await restored.listAgentProfiles();
  expect(result.profiles.map(profile => profile.name)).toEqual(hasFallback ? ['mine'] : []);
  expect(result.active_agent_profile_id).toBe(hasFallback ? result.profiles[0]!.id : null);
  await restored.updateSettings({ conversation_settings: { schema_version: 1, max_iterations: 12 } });
  expect(JSON.parse(await readFile(file, 'utf8')).agentProfiles.default).toEqual(corrupt);
  const app = Fastify(); registerAgentProfileRoutes(app, restored);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/agent-profiles/default' });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain('not a profile');
  } finally { await app.close(); }
});

it('counts corrupt occupied names toward the limit and permits an explicit repair without creating another entry', async () => {
  const { root, state, secretStore } = await fixture();
  await state.updateSettings({});
  const file = join(root, 'state.json'); const data = JSON.parse(await readFile(file, 'utf8'));
  for (let index = 0; index < 50; index++) data.agentProfiles[`bad-${index}`] = { bad: true };
  await writeFile(file, JSON.stringify(data));
  const restored = new ServerStateService({ stateDir: root, secretStore });
  expect(await restored.listAgentProfiles()).toEqual({ profiles: [], active_agent_profile_id: null });
  await expect(restored.saveAgentProfile(draft('new'))).rejects.toThrow(/limit/u);
  const repaired = await restored.saveAgentProfile(draft('bad-0'));
  expect(JSON.parse(await readFile(file, 'utf8')).agentProfiles['bad-0']).toEqual(repaired);
  expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).agentProfiles)).toHaveLength(50);
});

it('replaces deleted active default with a fresh ID and resets stale ACP settings while preserving MCP', async () => {
  const { state } = await fixture();
  const original = await state.saveAgentProfile(draft('default'));
  await state.activateAgentProfile(original.id);
  const mcp = { local: { command: 'fixture' } };
  await state.updateSettings({ agent_settings: { agent_kind: 'acp', acp_server: 'codex', mcp_config: mcp } });
  await state.deleteAgentProfile('default');
  const next = await state.listAgentProfiles();
  expect(next.profiles).toHaveLength(1); expect(next.profiles[0]!.id).not.toBe(original.id);
  expect(next.active_agent_profile_id).toBe(next.profiles[0]!.id);
  expect(await state.agentSettings()).toEqual({ ...defaultAgentSettings('default'), mcp_config: mcp });
});

it('does not rename inherited object keys and retains an accepted special target as an own entry', async () => {
  const { root, state, secretStore } = await fixture();
  await expect(state.renameAgentProfile('constructor', 'missing')).rejects.toThrow('profile_not_found');
  expect(await state.getAgentProfile('missing')).toBeNull();
  const profile = await state.saveAgentProfile(draft('constructor'));
  await state.renameAgentProfile('constructor', '__proto__');
  const result = await state.getAgentProfile('__proto__');
  expect(result).toMatchObject({ name: '__proto__', id: profile.id });
  const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  expect(Object.hasOwn(persisted.agentProfiles, '__proto__')).toBe(true);
  const restored = new ServerStateService({ stateDir: root, secretStore });
  expect(await restored.getAgentProfile('__proto__')).toEqual(result);
});
