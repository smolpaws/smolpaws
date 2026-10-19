import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemorySecretStore, defaultAgentSettings } from '@smolpaws/openhands-agent';
import { afterEach, expect, test } from 'vitest';
import { ServerStateService } from '../serverState.js';

// PORT: tests/agent_server/test_active_meta_profile.py at dcf401af.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'active-meta-')); roots.push(root);
  const secretStore = new InMemorySecretStore();
  return { root, secretStore, state: new ServerStateService({ stateDir: root, secretStore }) };
}

test('active meta selection propagates, clearing disables it and preserves the inline blob', async () => {
  const { state } = await fixture();
  const inline = { classifier_model: 'classifier', classes: [], prompt_template: null, model_table: null };
  await state.updateSettings({ agent_settings: { ...defaultAgentSettings('default'), meta_profile: inline } });
  const selected = await state.updateSettings({ active_meta_profile: 'balanced' });
  expect(selected).toMatchObject({ active_profile_id: 'default', active_meta_profile: 'balanced', agent_settings: {
    active_meta_profile: 'balanced', enable_classify_and_switch_llm_tool: true, meta_profile: inline,
  } });
  const cleared = await state.updateSettings({ active_meta_profile: null });
  expect(cleared).toMatchObject({ active_meta_profile: null, agent_settings: {
    active_meta_profile: null, enable_classify_and_switch_llm_tool: false, meta_profile: inline,
  } });
});

test('unrelated settings and replacement OpenHands settings preserve the selected facade', async () => {
  const { state } = await fixture();
  await state.updateSettings({ active_meta_profile: 'balanced' });
  await state.createMcpServer('svc', { command: 'test' });
  await state.updateSettings({ active_profile_id: 'default' });
  expect(await state.settings()).toMatchObject({ active_meta_profile: 'balanced', agent_settings: {
    active_meta_profile: 'balanced', enable_classify_and_switch_llm_tool: true, mcp_config: { svc: { command: 'test' } },
  } });
  await state.updateSettings({ agent_settings: defaultAgentSettings('default') });
  expect(await state.settings()).toMatchObject({ active_meta_profile: 'balanced', agent_settings: {
    active_meta_profile: 'balanced', enable_classify_and_switch_llm_tool: true,
  } });
});

test('ACP drops activation, switching to ACP clears facade, and returning permits activation', async () => {
  const { state } = await fixture();
  await state.updateSettings({ active_meta_profile: 'balanced' });
  await state.updateSettings({ agent_settings: { agent_kind: 'acp' } });
  expect(await state.settings()).toMatchObject({ active_meta_profile: null, agent_settings: { agent_kind: 'acp' } });
  await state.updateSettings({ active_meta_profile: 'balanced' });
  expect((await state.settings()).active_meta_profile).toBeNull();
  await state.updateSettings({ agent_settings: defaultAgentSettings('default'), active_meta_profile: 'balanced' });
  expect(await state.settings()).toMatchObject({ active_meta_profile: 'balanced', agent_settings: { active_meta_profile: 'balanced', enable_classify_and_switch_llm_tool: true } });
});

test('active selection survives restart and legacy state without its field loads null', async () => {
  const { root, state, secretStore } = await fixture();
  await state.updateSettings({ active_meta_profile: 'balanced' });
  expect(await new ServerStateService({ stateDir: root, secretStore }).settings()).toMatchObject({ active_meta_profile: 'balanced', agent_settings: { active_meta_profile: 'balanced' } });
  const file = path.join(root, 'state.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  delete old.settings.active_meta_profile;
  delete old.settings.agent_settings.active_meta_profile;
  delete old.settings.agent_settings.enable_classify_and_switch_llm_tool;
  await writeFile(file, JSON.stringify(old));
  expect((await new ServerStateService({ stateDir: root, secretStore }).settings()).active_meta_profile).toBeNull();
});
