import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, type LLMProfile } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test } from 'vitest';

import { ServerStateService } from '../serverState.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; state: ServerStateService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-state-'));
  roots.push(root);
  return { root, state: new ServerStateService({ stateDir: root, secretStore: new InMemorySecretStore() }) };
}

function renamed(profile: LLMProfile, profileId: string): LLMProfile {
  return { ...profile, profileId, model: `model-${profileId}` };
}

describe('ServerStateService persistence', () => {
  test('serializes concurrent distinct mutations without losing either update', async () => {
    const { root, state } = await fixture();
    const base = await state.getProfile('default');
    expect(base).not.toBeNull();
    await Promise.all([
      state.saveProfile(renamed(base!, 'alpha')),
      state.saveProfile(renamed(base!, 'beta')),
    ]);
    expect((await state.listProfiles()).profiles.map((profile) => profile.profileId)).toEqual(['alpha', 'beta', 'default']);
    const persisted = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')) as { llmProfiles: Record<string, unknown> };
    expect(Object.keys(persisted.llmProfiles).sort()).toEqual(['alpha', 'beta', 'default']);
  });

  test('shares one first-load result across concurrent readers', async () => {
    const { state } = await fixture();
    const [settings, profiles, secrets] = await Promise.all([state.settings(), state.listProfiles(), state.listSecrets()]);
    expect(settings.active_profile_id).toBe('default');
    expect(profiles.profiles).toHaveLength(1);
    expect(secrets).toEqual([]);
  });

  test.each(['{', JSON.stringify({ llmProfiles: {} })])('fails closed for corrupt persisted state', async (contents) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'server-state-'));
    roots.push(root);
    await writeFile(path.join(root, 'state.json'), contents, 'utf8');
    const state = new ServerStateService({ stateDir: root, secretStore: new InMemorySecretStore() });
    await expect(state.settings()).rejects.toThrow();
  });

  test('orders clear with an adjacent mutation', async () => {
    const { root, state } = await fixture();
    const base = await state.getProfile('default');
    await Promise.all([state.clear(), state.saveProfile(renamed(base!, 'after-clear'))]);
    expect(await state.getProfile('after-clear')).not.toBeNull();
    expect(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'))).toHaveProperty('llmProfiles.after-clear');
  });

  test('does not publish an in-memory snapshot when persistence fails', async () => {
    const { root, state } = await fixture();
    const base = await state.getProfile('default');
    await mkdir(path.join(root, 'state.json'));
    await expect(state.saveProfile(renamed(base!, 'unpersisted'))).rejects.toThrow();
    expect(await state.getProfile('unpersisted')).toBeNull();
  });
});
