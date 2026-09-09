import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentProfile,
  type LLMProfile,
  type SecretStore,
  defaultAgentSettings,
  llmProfileSecretRef,
  llmProviderSecretRef,
  validateAgentProfile,
  validateAgentSettings,
  validateConversationSettings,
  llmProfileSchema,
} from '@smolpaws/openhands-agent';

import type { SettingsResponse, SettingsUpdateRequest } from './models.js';

export class McpServerAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`MCP server '${key}' already exists`);
    this.name = 'McpServerAlreadyExistsError';
  }
}

export class McpServerNotFoundError extends Error {
  constructor(key: string) {
    super(`MCP server '${key}' was not found`);
    this.name = 'McpServerNotFoundError';
  }
}

interface SecretMetadata {
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PersistedState {
  readonly llmProfiles: Record<string, LLMProfile>;
  readonly agentProfiles: Record<string, AgentProfile>;
  readonly settings: SettingsResponse;
  readonly secrets: Record<string, SecretMetadata>;
}

const defaultProfileId = 'default';

export class ServerStateService {
  private readonly stateFile: string;
  private readonly secretStore: SecretStore;
  private state: PersistedState | null = null;
  private readonly readyPromise: Promise<PersistedState>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly stateDir: string; readonly secretStore: SecretStore }) {
    this.stateFile = path.join(options.stateDir, 'state.json');
    this.secretStore = options.secretStore;
    this.readyPromise = this.loadInitial();
  }

  async settings(): Promise<SettingsResponse> {
    const state = await this.load();
    return { ...state.settings, llm_api_key_set: await this.hasLlmApiKey(state.settings.active_profile_id) };
  }

  async updateSettings(update: SettingsUpdateRequest): Promise<SettingsResponse> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const activeProfileId = update.active_profile_id === undefined ? state.settings.active_profile_id : update.active_profile_id;
    if (activeProfileId !== null && state.llmProfiles[activeProfileId] === undefined) throw new Error('profile_not_found');
    const requestedAgentSettings = update.agent_settings === undefined ? state.settings.agent_settings : validateAgentSettings(update.agent_settings);
    const agentSettings = update.agent_settings === undefined && update.active_profile_id !== undefined && activeProfileId !== null && requestedAgentSettings.agent_kind === 'openhands'
      ? { ...requestedAgentSettings, llm_profile_ref: activeProfileId }
      : requestedAgentSettings;
    if (update.agent_settings !== undefined && agentSettings.agent_kind === 'openhands') {
      const profileRef = agentSettings.llm_profile_ref;
      if (typeof profileRef !== 'string' || state.llmProfiles[profileRef] === undefined) {
        throw new Error('profile_not_found');
      }
    }
    const settings: SettingsResponse = {
      ...state.settings,
      agent_settings: agentSettings,
      ...(update.conversation_settings === undefined ? {} : { conversation_settings: validateConversationSettings(update.conversation_settings) }),
      ...(update.active_profile_id === undefined ? {} : { active_profile_id: update.active_profile_id }),
      ...(update.active_agent_profile_id === undefined ? {} : { active_agent_profile_id: update.active_agent_profile_id }),
    };
    if (update.llm_api_key !== undefined && update.llm_api_key !== null && settings.active_profile_id !== null) {
      await this.commitWithSecretChange(
        llmProfileSecretRef(settings.active_profile_id),
        update.llm_api_key,
        { ...state, settings },
      );
      return this.settings();
    }
    await this.commit({ ...state, settings });
    return this.settings();
    });
  }

  async createMcpServer(key: string, server: Record<string, unknown>): Promise<SettingsResponse> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const mcpConfig = this.readMcpConfig(state);
    if (mcpConfig[key] !== undefined) throw new McpServerAlreadyExistsError(key);
    const nextConfig = { ...mcpConfig, [key]: compactRecord(server) };
    await this.writeMcpConfig(state, nextConfig);
    return this.settings();
    });
  }

  async patchMcpServer(key: string, patch: Record<string, unknown>): Promise<SettingsResponse> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const mcpConfig = this.readMcpConfig(state);
    const existing = mcpConfig[key];
    if (existing === undefined) throw new McpServerNotFoundError(key);
    const merged = mergeWithNullDelete(existing, patch);
    await this.writeMcpConfig(state, { ...mcpConfig, [key]: merged });
    return this.settings();
    });
  }

  async deleteMcpServer(key: string): Promise<SettingsResponse> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const mcpConfig = this.readMcpConfig(state);
    if (mcpConfig[key] === undefined) throw new McpServerNotFoundError(key);
    const nextConfig = { ...mcpConfig };
    delete nextConfig[key];
    await this.writeMcpConfig(state, nextConfig);
    return this.settings();
    });
  }

  private readMcpConfig(state: PersistedState): Record<string, unknown> {
    const mcpConfig = state.settings.agent_settings.mcp_config;
    return typeof mcpConfig === 'object' && mcpConfig !== null && !Array.isArray(mcpConfig)
      ? mcpConfig as Record<string, unknown>
      : {};
  }

  private async writeMcpConfig(state: PersistedState, mcpConfig: Record<string, unknown>): Promise<void> {
    const agentSettings = { ...state.settings.agent_settings, mcp_config: mcpConfig };
    await this.commit({ ...state, settings: { ...state.settings, agent_settings: agentSettings } });
  }

  async listProfiles(): Promise<{ readonly profiles: LLMProfile[]; readonly active_profile_id: string | null }> {
    const state = await this.load();
    return { profiles: Object.values(state.llmProfiles).sort((left, right) => left.profileId.localeCompare(right.profileId)), active_profile_id: state.settings.active_profile_id };
  }

  async getProfile(name: string): Promise<LLMProfile | null> {
    const state = await this.load();
    return state.llmProfiles[name] ?? null;
  }

  async saveProfile(profile: LLMProfile): Promise<LLMProfile> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    await this.commit({ ...state, llmProfiles: { ...state.llmProfiles, [profile.profileId]: profile } });
    return profile;
    });
  }

  async deleteProfile(name: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const profiles = withoutKey(state.llmProfiles, name);
    const active_profile_id = state.settings.active_profile_id === name ? null : state.settings.active_profile_id;
    await this.commitWithSecretChange(
      llmProfileSecretRef(name),
      null,
      { ...state, llmProfiles: profiles, settings: { ...state.settings, active_profile_id } },
    );
    });
  }

  async renameProfile(name: string, newName: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const profile = state.llmProfiles[name];
    if (profile === undefined) throw new Error('profile_not_found');
    if (name !== newName && state.llmProfiles[newName] !== undefined) throw new Error('profile_exists');
    const profiles = withoutKey(state.llmProfiles, name);
    profiles[newName] = { ...profile, profileId: newName };
    const active_profile_id = state.settings.active_profile_id === name ? newName : state.settings.active_profile_id;
    const agentSettings = state.settings.agent_settings.agent_kind === 'openhands' && state.settings.agent_settings.llm_profile_ref === name
      ? { ...state.settings.agent_settings, llm_profile_ref: newName }
      : state.settings.agent_settings;
    await this.commit({ ...state, llmProfiles: profiles, settings: { ...state.settings, agent_settings: agentSettings, active_profile_id } });
    });
  }

  async activateProfile(name: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    if (state.llmProfiles[name] === undefined) throw new Error('profile_not_found');
    const agentSettings = state.settings.agent_settings.agent_kind === 'openhands'
      ? { ...state.settings.agent_settings, llm_profile_ref: name }
      : state.settings.agent_settings;
    await this.commit({ ...state, settings: { ...state.settings, agent_settings: agentSettings, active_profile_id: name } });
    });
  }

  async listAgentProfiles(): Promise<{ readonly profiles: AgentProfile[]; readonly active_agent_profile_id: string | null }> {
    const state = await this.load();
    return { profiles: Object.values(state.agentProfiles).sort((left, right) => left.name.localeCompare(right.name)), active_agent_profile_id: state.settings.active_agent_profile_id };
  }

  async getAgentProfile(name: string): Promise<AgentProfile | null> {
    const state = await this.load();
    return state.agentProfiles[name] ?? null;
  }

  async saveAgentProfile(payload: unknown): Promise<AgentProfile> {
    const profile = validateAgentProfile(payload);
    return this.serializeMutation(async () => {
    const state = await this.load();
    await this.commit({ ...state, agentProfiles: { ...state.agentProfiles, [profile.name]: profile } });
    return profile;
    });
  }

  async deleteAgentProfile(name: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const deleted = state.agentProfiles[name];
    const profiles = withoutKey(state.agentProfiles, name);
    const active_agent_profile_id = deleted?.id === state.settings.active_agent_profile_id ? null : state.settings.active_agent_profile_id;
    await this.commit({ ...state, agentProfiles: profiles, settings: { ...state.settings, active_agent_profile_id } });
    });
  }

  async renameAgentProfile(name: string, newName: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const profile = state.agentProfiles[name];
    if (profile === undefined) throw new Error('profile_not_found');
    if (name !== newName && state.agentProfiles[newName] !== undefined) throw new Error('profile_exists');
    const profiles = withoutKey(state.agentProfiles, name);
    profiles[newName] = { ...profile, name: newName };
    await this.commit({ ...state, agentProfiles: profiles });
    });
  }

  async activateAgentProfile(profileId: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    if (!Object.values(state.agentProfiles).some((profile) => profile.id === profileId)) throw new Error('profile_not_found');
    await this.commit({ ...state, settings: { ...state.settings, active_agent_profile_id: profileId } });
    });
  }

  async listSecrets(): Promise<SecretMetadata[]> {
    const state = await this.load();
    return Object.values(state.secrets).sort((left, right) => left.name.localeCompare(right.name));
  }

  async setSecret(name: string, value: string): Promise<SecretMetadata> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const now = new Date().toISOString();
    const existing = state.secrets[name];
    const item = { name, created_at: existing?.created_at ?? now, updated_at: now };
    await this.commitWithSecretChange(
      { service: 'openhands', account: `agent-server-secret:${name}` },
      value,
      { ...state, secrets: { ...state.secrets, [name]: item } },
    );
    return item;
    });
  }

  async getSecretMetadata(name: string): Promise<SecretMetadata | null> {
    const state = await this.load();
    return state.secrets[name] ?? null;
  }

  async deleteSecret(name: string): Promise<void> {
    return this.serializeMutation(async () => {
    const state = await this.load();
    const secrets = withoutKey(state.secrets, name);
    await this.commitWithSecretChange(
      { service: 'openhands', account: `agent-server-secret:${name}` },
      null,
      { ...state, secrets },
    );
    });
  }

  private async hasLlmApiKey(profileId: string | null): Promise<boolean> {
    if (profileId === null) return this.secretStore.has(llmProviderSecretRef('openai'));
    return this.secretStore.has(llmProfileSecretRef(profileId));
  }

  private async load(): Promise<PersistedState> {
    if (this.state !== null) return this.state;
    return this.readyPromise;
  }

  private async loadInitial(): Promise<PersistedState> {
    try {
      const parsed = validatePersistedState(JSON.parse(await readFile(this.stateFile, 'utf8')) as unknown);
      this.state = parsed;
      return parsed;
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT')) throw error;
      const initial = defaultState();
      this.state = initial;
      return initial;
    }
  }

  private async commit(next: PersistedState): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporaryFile, this.stateFile);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }
    this.state = next;
  }

  private async commitWithSecretChange(
    ref: Parameters<SecretStore['get']>[0],
    value: string | null,
    next: PersistedState,
  ): Promise<void> {
    const previous = await this.secretStore.get(ref);
    if (value === null) await this.secretStore.delete(ref);
    else await this.secretStore.set(ref, value);
    try {
      await this.commit(next);
    } catch (error) {
      if (previous === null) await this.secretStore.delete(ref);
      else await this.secretStore.set(ref, previous);
      throw error;
    }
  }

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  async clear(): Promise<void> {
    return this.serializeMutation(async () => {
      await this.load();
      await rm(this.stateFile, { force: true });
      this.state = defaultState();
    });
  }
}

function defaultState(): PersistedState {
  const profile: LLMProfile = {
    profileId: defaultProfileId,
    providerId: 'openai',
    model: 'gpt-5-nano',
    baseUrl: null,
    openAiApiMode: 'responses',
    temperature: null,
    topP: null,
    topK: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    timeoutSeconds: null,
    reasoningEffort: null,
    reasoningSummary: null,
    promptCacheRetention: null,
    promptCacheKey: null,
    headers: {},
    useProfileKeyOverride: false,
  };
  return {
    llmProfiles: { [profile.profileId]: profile },
    agentProfiles: {},
    settings: {
      agent_settings: defaultAgentSettings(profile.profileId),
      conversation_settings: { schema_version: 1, max_iterations: 500, observability_metadata: null, observability_tags: null },
      llm_api_key_set: false,
      active_profile_id: profile.profileId,
      active_agent_profile_id: null,
    },
    secrets: {},
  };
}

function validatePersistedState(value: unknown): PersistedState {
  if (!isPlainObject(value)
    || !isPlainObject(value.llmProfiles)
    || !isPlainObject(value.agentProfiles)
    || !isPlainObject(value.settings)
    || !isPlainObject(value.secrets)) {
    throw new Error('invalid server state: expected profile, settings, and secret maps');
  }
  const llmProfiles = Object.fromEntries(Object.entries(value.llmProfiles).map(([key, profile]) => {
    const parsed = llmProfileSchema.parse(profile);
    if (parsed.profileId !== key) throw new Error(`invalid server state: LLM profile key '${key}' does not match its profileId`);
    return [key, parsed];
  }));
  const agentProfiles = Object.fromEntries(Object.entries(value.agentProfiles).map(([key, profile]) => {
    const parsed = validateAgentProfile(profile);
    if (parsed.name !== key) throw new Error(`invalid server state: agent profile key '${key}' does not match its name`);
    return [key, parsed];
  }));
  const settingsValue = value.settings;
  const settings: SettingsResponse = {
    agent_settings: validateAgentSettings(settingsValue.agent_settings),
    conversation_settings: validateConversationSettings(settingsValue.conversation_settings),
    llm_api_key_set: settingsValue.llm_api_key_set === true,
    active_profile_id: nullableString(settingsValue.active_profile_id, 'active_profile_id'),
    active_agent_profile_id: nullableString(settingsValue.active_agent_profile_id, 'active_agent_profile_id'),
  };
  const secrets = Object.fromEntries(Object.entries(value.secrets).map(([key, metadata]) => {
    if (!isPlainObject(metadata)
      || metadata.name !== key
      || typeof metadata.created_at !== 'string'
      || typeof metadata.updated_at !== 'string') {
      throw new Error(`invalid server state: secret metadata '${key}' is malformed`);
    }
    return [key, { name: key, created_at: metadata.created_at, updated_at: metadata.updated_at }];
  }));
  return { llmProfiles, agentProfiles, settings, secrets };
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`invalid server state: ${field} must be a string or null`);
}

function isErrno(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

// Upstream create drops None/defaulted fields (``exclude_none=True, exclude_defaults=True``),
// so a top-level null is not persisted as an explicit field.
function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    result[key] = value;
  }
  return result;
}

// Upstream ``PersistedSettings.update`` deep-merges the ``agent_settings_diff`` map, and a
// null value inside a nested map deletes that entry. Reproduce the same merge here so a
// sparse PATCH (e.g. ``{"description": "..."}``) preserves siblings while ``{"auth": null}``
// removes one key.
function mergeWithNullDelete(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const merged = mergeWithNullDelete(result[key], value);
    if (merged === undefined) {
      delete result[key];
    } else {
      result[key] = merged;
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
