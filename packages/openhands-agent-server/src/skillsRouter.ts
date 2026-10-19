import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { installSkillRequestSchema, skillsRequestSchema, updateSkillStateRequestSchema } from './skillsModels.js';
import { param, parseBody } from './routeUtils.js';
import { skillInfo, SkillsCatalogService, SkillsServiceError } from './skillsService.js';

export function registerSkillsRoutes(app: FastifyInstance, options: { readonly service: SkillsCatalogService } | { readonly stateDir: string; readonly workspaceRoot: string; readonly service?: SkillsCatalogService }): void {
  const service = options.service ?? new SkillsCatalogService(options as { stateDir: string; workspaceRoot: string });
  const safe = async (reply: FastifyReply, operation: () => Promise<unknown>) => {
    try { return await operation(); } catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ detail: 'Invalid skills request' });
      return reply.status(error instanceof SkillsServiceError ? error.statusCode : 500).send({ detail: error instanceof SkillsServiceError ? error.message : 'Skill operation failed' });
    }
  };
  const missing = (reply: FastifyReply) => reply.status(404).send({ detail: 'Skill not installed' });
  app.post('/api/skills', async (request, reply) => safe(reply, async () => { const loaded = await service.load(parseBody(skillsRequestSchema, request.body)); return { skills: loaded.skills.map(skillInfo), sources: loaded.sources }; }));
  app.post('/api/skills/sync', async () => service.syncPublicSkills());
  app.post('/api/skills/install', async (request, reply) => safe(reply, async () => service.install(parseBody(installSkillRequestSchema, request.body))));
  app.get('/api/skills/installed', async (_request, reply) => safe(reply, async () => ({ skills: await service.listInstalled() })));
  app.get('/api/skills/installed/:skill_name', async (request, reply) => safe(reply, async () => (await service.getInstalled(param(request, 'skill_name'))) ?? missing(reply)));
  app.patch('/api/skills/installed/:skill_name', async (request, reply) => safe(reply, async () => {
    const name = param(request, 'skill_name'); const body = parseBody(updateSkillStateRequestSchema, request.body);
    return await service.setEnabled(name, body.enabled) ? { name, enabled: body.enabled } : missing(reply);
  }));
  app.delete('/api/skills/installed/:skill_name', async (request, reply) => safe(reply, async () => {
    const name = param(request, 'skill_name'); return await service.uninstall(name) ? { message: `Skill '${name}' uninstalled` } : missing(reply);
  }));
  app.post('/api/skills/installed/:skill_name/refresh', async (request, reply) => safe(reply, async () => {
    const name = param(request, 'skill_name'); const skill = await service.refresh(name); return skill ? { message: `Skill '${name}' updated`, skill } : missing(reply);
  }));
  app.get('/api/skills/marketplace', async (_request, reply) => safe(reply, async () => ({ skills: await service.marketplaceCatalog() })));
}
