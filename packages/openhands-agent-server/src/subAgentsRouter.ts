import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BROWSER_TOOL_NAME, discoverAgents, discoverBuiltinAgents, getToolCatalog, isToolAvailable, listRegisteredTools, type AgentDefinition } from '@smolpaws/openhands-agent';
import type { AgentServerConfig } from './config.js';
import { parseBody } from './routeUtils.js';

export const subAgentsRequestSchema = z.object({ load_user: z.boolean().default(true), load_project: z.boolean().default(true), load_builtin: z.boolean().default(true), project_dir: z.string().nullable().default(null) });
const mapping = z.record(z.string(), z.unknown()).nullable().default(null);
export const subAgentInfoSchema = z.object({
  name: z.string(), description: z.string().default(''), model: z.string().default('inherit'), color: z.string().nullable().default(null),
  tools: z.array(z.string()).default([]), skills: z.array(z.string()).default([]), system_prompt: z.string().default(''), when_to_use_examples: z.array(z.string()).default([]),
  permission_mode: z.string().nullable().default(null), max_iteration_per_run: z.number().int().nullable().default(null), max_budget_per_run: z.number().nullable().default(null),
  mcp_config: mapping, mcp_servers: mapping, profile_store_dir: z.string().nullable().default(null), hooks: z.unknown().nullable().default(null), condenser: z.unknown().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}), level: z.enum(['project', 'user', 'builtin', 'plugin', 'programmatic']).nullable().default(null), source: z.string().nullable().default(null), is_builtin: z.boolean().default(false),
});
export const subAgentsResponseSchema = z.object({ agents: z.array(subAgentInfoSchema) });

/** Local configuration only. Read-only builtin discovery does not establish runtime availability. */
export function configuredBrowserAvailable(config: Pick<AgentServerConfig, 'enableBrowser'>): false | null {
  return config.enableBrowser === false ? false : null;
}
export function usableServerTools(config: Pick<AgentServerConfig, 'enableBrowser'>): string[] {
  const names = [...new Set([...listRegisteredTools(), ...getToolCatalog().map(tool => tool.name)])];
  return names.filter(name => isToolAvailable(name) && (name !== BROWSER_TOOL_NAME || configuredBrowserAvailable(config) !== false)).sort();
}
export function registerSubAgentRoutes(app: FastifyInstance, config: AgentServerConfig): void {
  app.post('/api/sub-agents', async request => {
    const body = parseBody(subAgentsRequestSchema, request.body);
    const found = await discoverAgents({ projectDir: body.project_dir, includeProject: body.load_project, includeUser: body.load_user });
    const builtins = body.load_builtin ? discoverBuiltinAgents({ enableBrowser: configuredBrowserAvailable(config) !== false }) : [];
    const chosen = new Map<string, AgentDefinition>();
    for (const definition of [...found, ...builtins]) if (!chosen.has(definition.name)) chosen.set(definition.name, definition);
    return { agents: [...chosen.values()].map(definition => subAgentInfoSchema.parse({ ...definition, mcp_servers: definition.mcp_config, is_builtin: definition.level === 'builtin' })) };
  });
}
