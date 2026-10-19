import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BROWSER_TOOL_NAME, InMemorySecretStore, ToolDefinition, globalToolRegistry } from '@smolpaws/openhands-agent';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ServerStateService } from '../serverState.js';
import { prepareServerStartRequest } from '../launch.js';
import { createProfileAgentFactory } from '../profileAgentFactory.js';
import type { StoredConversation } from '../models.js';

it('only injects a real host browser when the native launch runtime declares it available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-launch-'));
  const secretStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: root, secretStore });
  const browser = new ToolDefinition({ name: 'browser_driver', description: 'fixture', inputSchema: z.object({}) });
  const materialize = vi.fn(() => [browser]);
  globalToolRegistry.registerFactory(BROWSER_TOOL_NAME, materialize, { isUsable: () => true });
  try {
    const request = await prepareServerStartRequest({ agent: { llm_profile_ref: 'default', tools: [{ name: BROWSER_TOOL_NAME }], condenser: { enabled: false } }, persistence_dir: root }, state);
    const stored: StoredConversation = { id: randomUUID(), request, workspace: { kind: 'LocalWorkspace', working_dir: root }, title: null, tags: {}, secret_names: [], created_at: '', updated_at: '' };
    for (const browserAvailable of [false, true]) {
      const factory = createProfileAgentFactory({ state, secretStore, browserAvailable,
        llmClientFactory: async profile => ({ profile, async complete() { throw new Error('no completion'); } }) });
      const agent = await factory(request.agent, { stored });
      expect(agent.tools.some(tool => tool.name === browser.name)).toBe(browserAvailable);
    }
    expect(materialize).toHaveBeenCalledOnce();
  } finally {
    globalToolRegistry.registerFactory(BROWSER_TOOL_NAME, () => { throw new Error('unavailable'); }, { isUsable: () => false });
    await rm(root, { recursive: true, force: true });
  }
});
