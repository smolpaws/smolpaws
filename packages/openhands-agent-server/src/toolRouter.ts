import type { FastifyInstance } from 'fastify';
import { getToolCatalog, listRegisteredTools, sealToolCatalog } from '@smolpaws/openhands-agent';
import { ensureProfileToolsRegistered } from './profileTools.js';

export function registerToolRoutes(app: FastifyInstance): void {
  ensureProfileToolsRegistered();
  sealToolCatalog();
  // Native builtins are fallback resolvers, rather than entries in the host registry.
  const available = () => [...new Set([...listRegisteredTools(), ...getToolCatalog().map(tool => tool.name)])];
  app.get('/api/tools', async () => available());
  app.get('/api/tools/', async () => available());
  app.get('/api/tools/catalog', async () => ({ tools: getToolCatalog() }));
}
