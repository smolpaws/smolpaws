import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BROWSER_TOOL_NAME, InMemorySecretStore, globalToolRegistry } from '@smolpaws/openhands-agent';
import { createAgentServerApp } from '../app.js';

it('lists readonly project and builtin definitions with first-wins and browser configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server04-catalog-'));
  await mkdir(join(root, '.agents', 'agents'), { recursive: true });
  await writeFile(join(root, '.agents', 'agents', 'custom.md'), '---\nname: general-purpose\nmcp_config:\n  custom:\n    command: fixture\n---\nProject override');
  try {
    for (const enabled of [true, false]) {
      const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(), config: {
        workspaceRoot: root, conversationsPath: join(root, String(enabled), 'conversations'), statePath: join(root, String(enabled), 'state'), bashEventsPath: join(root, 'bash'), enableBrowser: enabled,
      } });
      try {
        const result = await server.app.inject({ method: 'POST', url: '/api/sub-agents', payload: { load_user: false, project_dir: root } });
        expect(result.statusCode).toBe(200);
        const agents = result.json().agents;
        expect(agents.filter((agent: {name:string}) => agent.name === 'general-purpose')).toHaveLength(1);
        const custom = agents.find((agent: {name:string}) => agent.name === 'general-purpose');
        expect(custom).toMatchObject({ level: 'project', is_builtin: false, system_prompt: 'Project override' });
        expect(custom.mcp_servers).toEqual(custom.mcp_config); expect(custom.mcp_config.custom.enabled).toBe(true);
        expect(agents.some((agent: {name:string}) => agent.name === 'web-researcher')).toBe(enabled);
        const none = await server.app.inject({ method: 'POST', url: '/api/sub-agents', payload: { load_user: false, load_project: false, load_builtin: false } });
        expect(none.json()).toEqual({ agents: [] });
        const info = (await server.app.inject('/server_info')).json();
        expect(info.usable_tools).toContain('terminal'); expect(info.usable_tools).toContain('file_editor');
        expect(info.usable_tools).not.toContain(BROWSER_TOOL_NAME); expect(info.usable_tools).not.toContain('bash');
      } finally { await server.app.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('server info applies browser disable without inventing a browser implementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server04-browser-'));
  globalToolRegistry.registerFactory(BROWSER_TOOL_NAME, () => { throw new Error('catalog must not construct'); }, { isUsable: () => true });
  try {
    for (const enabled of [true, false]) {
      const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(), config: { workspaceRoot: root, statePath: join(root, 'state'), conversationsPath: join(root, 'conversations'), bashEventsPath: join(root, 'bash'), enableBrowser: enabled } });
      try { expect((await server.app.inject('/server_info')).json().usable_tools.includes(BROWSER_TOOL_NAME)).toBe(enabled); }
      finally { await server.app.close(); }
    }
  } finally {
    globalToolRegistry.registerFactory(BROWSER_TOOL_NAME, () => { throw new Error('unavailable'); }, { isUsable: () => false });
    await rm(root, { recursive: true, force: true });
  }
});
