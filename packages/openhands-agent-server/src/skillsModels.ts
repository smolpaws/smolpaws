import { z } from 'zod';

export const installedSkillNameSchema = z.string().max(255).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const repoPathSchema = z.string().min(1).refine(value => !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !value.split('/').includes('..'));
export const marketplaceRegistrationSchema = z.object({
  name: z.string(), source: z.string(), ref: z.string().nullable().default(null),
  repo_path: repoPathSchema.nullable().default(null), auto_load: z.union([z.boolean(), z.array(z.string())]).default(false),
});
export type MarketplaceRegistration = z.infer<typeof marketplaceRegistrationSchema>;
export const orgSkillsConfigSchema = z.object({ repository: z.string(), provider: z.string(), org_repo_url: z.string(), org_name: z.string() });
export const sandboxSkillsConfigSchema = z.object({ exposed_urls: z.array(z.object({ name: z.string(), url: z.string(), port: z.number().int() })).default([]) });
export const skillsRequestSchema = z.object({
  load_public: z.boolean().default(true), load_user: z.boolean().default(true),
  load_project: z.boolean().default(true), load_org: z.boolean().default(true),
  project_dir: z.string().nullable().default(null), marketplace_path: z.string().nullable().default('marketplaces/default.json'),
  registered_marketplaces: z.array(marketplaceRegistrationSchema).default([]),
  sandbox_config: sandboxSkillsConfigSchema.nullable().default(null), org_configs: z.array(orgSkillsConfigSchema).nullable().default(null),
}).passthrough();
export type SkillsRequest = z.infer<typeof skillsRequestSchema>;
export const skillInfoSchema = z.object({
  name: z.string(), type: z.enum(['repo', 'knowledge', 'agentskills']), content: z.string(),
  triggers: z.array(z.string()).default([]), source: z.string().nullable().default(null), description: z.string().nullable().default(null),
  is_agentskills_format: z.boolean().default(false), disable_model_invocation: z.boolean().default(false),
}).strict();
export const skillsResponseSchema = z.object({ skills: z.array(skillInfoSchema), sources: z.record(z.string(), z.number().int().nonnegative()).default({}) }).strict();
export const syncResponseSchema = z.object({ status: z.enum(['success', 'error']), message: z.string() }).strict();
export const installSkillRequestSchema = z.object({ source: z.string().min(1), ref: z.string().nullable().default(null), repo_path: z.string().nullable().default(null), force: z.boolean().default(false) }).strict();
export type InstallSkillRequest = z.infer<typeof installSkillRequestSchema>;
export const installedSkillResponseSchema = z.object({
  name: installedSkillNameSchema, version: z.string().default(''), description: z.string().default(''), enabled: z.boolean().default(true),
  source: z.string(), resolved_ref: z.string().nullable().default(null), repo_path: z.string().nullable().default(null),
  installed_at: z.string(), install_path: z.string(),
}).strict();
export type InstalledSkillInfo = z.infer<typeof installedSkillResponseSchema>;
export const installedSkillsListResponseSchema = z.object({ skills: z.array(installedSkillResponseSchema) }).strict();
export const updateSkillStateRequestSchema = z.object({ enabled: z.boolean() }).strict();
export const updateSkillStateResponseSchema = z.object({ name: z.string(), enabled: z.boolean() }).strict();
export const uninstallSkillResponseSchema = z.object({ message: z.string() }).strict();
export const updateSkillResponseSchema = z.object({ message: z.string(), skill: installedSkillResponseSchema }).strict();
export const marketplaceSkillInfoSchema = z.object({ name: z.string(), description: z.string().nullable(), source: z.string(), installed: z.boolean() }).strict();
export type MarketplaceSkillInfo = z.infer<typeof marketplaceSkillInfoSchema>;
export const marketplaceCatalogResponseSchema = z.object({ skills: z.array(marketplaceSkillInfoSchema) }).strict();
