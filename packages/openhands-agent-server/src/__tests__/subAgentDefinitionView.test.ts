import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { getRegisteredAgentDefinitions } from '@smolpaws/openhands-agent';
import { expect, it } from 'vitest';
import { registerSubAgentRoutes } from '../subAgentsRouter.js';
import { getDefaultConfig } from '../config.js';

it('returns the pinned full-frontmatter view with literal placeholders and no registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-view-'));
  const directory = join(root, '.agents', 'agents'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'full.md'), `---
name: full
description: Fully specified agent
model: inherit
color: purple
tools: [TerminalTool]
skills: [some-skill]
permission_mode: confirm_risky
max_iteration_per_run: 7
max_budget_per_run: 1.5
profile_store_dir: /tmp/profiles
mcp_config:
  fetch:
    command: uvx
    args: [--with, mcp==1.29.0, mcp-server-fetch==2026.7.10]
    env: {TOKEN: "\${TOKEN}"}
condenser: none
custom_key: custom_value
---
You are a fully specified agent.`);
  const before = getRegisteredAgentDefinitions();
  const app = Fastify(); registerSubAgentRoutes(app, getDefaultConfig({}));
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sub-agents', payload: { load_builtin: false, load_user: false, project_dir: root } });
    expect(response.statusCode).toBe(200);
    expect(response.json().agents).toEqual([expect.objectContaining({ name: 'full', description: 'Fully specified agent', model: 'inherit', color: 'purple',
      tools: ['TerminalTool'], skills: ['some-skill'], permission_mode: 'confirm_risky', max_iteration_per_run: 7, max_budget_per_run: 1.5,
      profile_store_dir: '/tmp/profiles', condenser: { kind: 'NoOpCondenser' }, metadata: { custom_key: 'custom_value' }, level: 'project', is_builtin: false,
      system_prompt: 'You are a fully specified agent.', source: join(directory, 'full.md') })]);
    const agent = response.json().agents[0];
    expect(agent.mcp_config).toEqual({ fetch: { command: 'uvx', args: ['--with', 'mcp==1.29.0', 'mcp-server-fetch==2026.7.10'], env: { TOKEN: '${TOKEN}' }, enabled: true } });
    expect(agent.mcp_servers).toEqual(agent.mcp_config);
    expect(getRegisteredAgentDefinitions()).toEqual(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
