/** Product role selections. Profile records and credentials remain owned by the server. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProfileSelectionResolver } from '../../../packages/openhands-agent-server/src/profileRuntime.js';
import type { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { loadScheduledAgent, type ScheduledAgentOptions } from './scheduledAgents.js';

export interface ProductModelOptions { configPath?: string; homeDir?: string; scheduledAgents?: ScheduledAgentOptions }
export interface ModelSelections {
  version: 1;
  roles?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const roles = (value: unknown): value is Record<string, string> => record(value) && Object.entries(value).every(([role, ref]) =>
  /^[a-z][a-z0-9_-]*$/.test(role) && typeof ref === 'string' && ref.length > 0 && ref.trim() === ref);

function parseModelSelections(value: unknown): ModelSelections {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'roles', 'scopes'].includes(key))
    || (value.roles !== undefined && !roles(value.roles))
    || (value.scopes !== undefined && (!record(value.scopes) || !Object.entries(value.scopes).every(([scope, selection]) =>
      /^[a-z][a-z0-9_-]*:[^*\s]+$/.test(scope) && roles(selection))))) {
    throw new Error('Invalid SmolPaws model configuration');
  }
  return value as unknown as ModelSelections;
}

/** Read on use so an atomic file edit applies before the next model call without a restart. */
export async function loadModelSelections(options: ProductModelOptions = {}): Promise<ModelSelections> {
  const home = options.homeDir ?? (process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws'));
  const explicit = options.configPath ?? (process.env.SMOLPAWS_MODELS_CONFIG?.trim() || undefined);
  const selected = explicit ?? path.join(home, 'models.json');
  const file = path.resolve(selected.startsWith('~/') ? path.join(homedir(), selected.slice(2)) : selected);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (explicit === undefined && record(error) && error.code === 'ENOENT') return { version: 1 };
    throw error;
  }
  // JSON parse errors can quote source text. Do not echo potentially misplaced credentials.
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Invalid SmolPaws model configuration'); }
  return parseModelSelections(value);
}

export function selectRoleProfile(config: ModelSelections, role: string, scope?: string): string | undefined {
  const scoped = scope === undefined ? undefined : config.scopes?.[scope];
  return (scoped && Object.hasOwn(scoped, role) ? scoped[role] : undefined)
    ?? (config.roles && Object.hasOwn(config.roles, role) ? config.roles[role] : undefined);
}

export function productProfileSelection(scheduler: TaskScheduler, options: ProductModelOptions = {}): ProfileSelectionResolver {
  return async ({ stored }) => {
    const lane = scheduler.lane(stored.id);
    if (!lane) throw new Error('Model selection requires a registered scheduler lane');
    const scheduled = loadScheduledAgent(stored.id, scheduler, { homeDir: options.homeDir, ...options.scheduledAgents });
    if (scheduled) return scheduled.profile;
    return selectRoleProfile(await loadModelSelections(options), 'agent', `${lane.lane.platform}:${lane.scopeId}`);
  };
}

/** Condenser role is captured once by the server; scheduled main profiles are unrelated. */
export function productCondenserProfileSelection(scheduler: TaskScheduler, options: ProductModelOptions = {}): ProfileSelectionResolver {
  return async ({ stored }) => {
    const lane = scheduler.lane(stored.id);
    if (!lane) throw new Error('Model selection requires a registered scheduler lane');
    return selectRoleProfile(await loadModelSelections(options), 'condenser', `${lane.lane.platform}:${lane.scopeId}`);
  };
}
