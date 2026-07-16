import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
} from '@smolpaws/openhands-agent';

import type { SettingsResponse, SettingsUpdateRequest } from './models.js';

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

  constructor(options: { readonly stateDir: string; readonly secretStore: SecretStore }) {
    this.stateFile = path.join(options.stateDir, 'state.json');
    this.secretStore = options.secretStore;
  }

  async settings(): Promise<SettingsResponse> {
    const state = await this.load();
    return { ...state.settings, llm_api_key_set: await this.hasLlmApiKey(state.settings.active_profile_id) };
  }

  async updateSettings(update: SettingsUpdateRequest): Promise<SettingsResponse> {
    const state = await this.load();
    const activeProfileId = update.active_profile_id === undefined ? state.settings.active_profile_id : update.active_profile_id;
    if (activeProfileId !== null && state.llmProfiles[activeProfileId] === undefined) throw new Error('profile_not_found');
    const requestedAgentSettings = update.agent_settings === undefined ? state.settings.agent_settings : validateAgentSettings(update.agent_settings);
    const agentSettings = update.agent_settings === undefined && activeProfileId !== null && requestedAgentSettings.agent_kind === 'openhands'
      ? { ...requestedAgentSettings, llm_profile_ref: activeProfileId }
      : requestedAgentSettings;
    const settings: SettingsResponse = {
      ...state.settings,
      agent_settings: agentSettings,
      ...(update.conversation_settings === undefined ? {} : { conversation_settings: validateConversationSettings(update.conversation_settings) }),
      ...(update.active_profile_id === undefined ? {} : { active_profile_id: update.active_profile_id }),
      ...(update.active_agent_profile_id === undefined ? {} : { active_agent_profile_id: update.active_agent_profile_id }),
    };
    if (update.llm_api_key !== undefined && update.llm_api_key !== null && settings.active_profile_id !== null) {
      await this.secretStore.set(llmProfileSecretRef(settings.active_profile_id), update.llm_api_key);
    }
    this.state = { ...state, settings };
    await this.save();
    return this.settings();
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
    const state = await this.load();
    this.state = { ...state, llmProfiles: { ...state.llmProfiles, [profile.profileId]: profile } };
    await this.save();
    return profile;
  }

  async deleteProfile(name: string): Promise<void> {
    const state = await this.load();
    const profiles = withoutKey(state.llmProfiles, name);
    const active_profile_id = state.settings.active_profile_id === name ? null : state.settings.active_profile_id;
    this.state = { ...state, llmProfiles: profiles, settings: { ...state.settings, active_profile_id } };
    await this.secretStore.delete(llmProfileSecretRef(name));
    await this.save();
  }

  async renameProfile(name: string, newName: string): Promise<void> {
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
    this.state = { ...state, llmProfiles: profiles, settings: { ...state.settings, agent_settings: agentSettings, active_profile_id } };
    await this.save();
  }

  async activateProfile(name: string): Promise<void> {
    const state = await this.load();
    if (state.llmProfiles[name] === undefined) throw new Error('profile_not_found');
    const agentSettings = state.settings.agent_settings.agent_kind === 'openhands'
      ? { ...state.settings.agent_settings, llm_profile_ref: name }
      : state.settings.agent_settings;
    this.state = { ...state, settings: { ...state.settings, agent_settings: agentSettings, active_profile_id: name } };
    await this.save();
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
    const state = await this.load();
    this.state = { ...state, agentProfiles: { ...state.agentProfiles, [profile.name]: profile } };
    await this.save();
    return profile;
  }

  async deleteAgentProfile(name: string): Promise<void> {
    const state = await this.load();
    const deleted = state.agentProfiles[name];
    const profiles = withoutKey(state.agentProfiles, name);
    const active_agent_profile_id = deleted?.id === state.settings.active_agent_profile_id ? null : state.settings.active_agent_profile_id;
    this.state = { ...state, agentProfiles: profiles, settings: { ...state.settings, active_agent_profile_id } };
    await this.save();
  }

  async renameAgentProfile(name: string, newName: string): Promise<void> {
    const state = await this.load();
    const profile = state.agentProfiles[name];
    if (profile === undefined) throw new Error('profile_not_found');
    if (name !== newName && state.agentProfiles[newName] !== undefined) throw new Error('profile_exists');
    const profiles = withoutKey(state.agentProfiles, name);
    profiles[newName] = { ...profile, name: newName };
    this.state = { ...state, agentProfiles: profiles };
    await this.save();
  }

  async activateAgentProfile(profileId: string): Promise<void> {
    const state = await this.load();
    if (!Object.values(state.agentProfiles).some((profile) => profile.id === profileId)) throw new Error('profile_not_found');
    this.state = { ...state, settings: { ...state.settings, active_agent_profile_id: profileId } };
    await this.save();
  }

  async listSecrets(): Promise<SecretMetadata[]> {
    const state = await this.load();
    return Object.values(state.secrets).sort((left, right) => left.name.localeCompare(right.name));
  }

  async setSecret(name: string, value: string): Promise<SecretMetadata> {
    const state = await this.load();
    const now = new Date().toISOString();
    const existing = state.secrets[name];
    const item = { name, created_at: existing?.created_at ?? now, updated_at: now };
    await this.secretStore.set({ service: 'openhands', account: `agent-server-secret:${name}` }, value);
    this.state = { ...state, secrets: { ...state.secrets, [name]: item } };
    await this.save();
    return item;
  }

  async getSecretMetadata(name: string): Promise<SecretMetadata | null> {
    const state = await this.load();
    return state.secrets[name] ?? null;
  }

  async deleteSecret(name: string): Promise<void> {
    const state = await this.load();
    const secrets = withoutKey(state.secrets, name);
    await this.secretStore.delete({ service: 'openhands', account: `agent-server-secret:${name}` });
    this.state = { ...state, secrets };
    await this.save();
  }

  private async hasLlmApiKey(profileId: string | null): Promise<boolean> {
    if (profileId === null) return this.secretStore.has(llmProviderSecretRef('openai'));
    return this.secretStore.has(llmProfileSecretRef(profileId));
  }

  private async load(): Promise<PersistedState> {
    if (this.state !== null) return this.state;
    const parsed = await readFile(this.stateFile, 'utf8').then((raw) => JSON.parse(raw) as PersistedState).catch(() => null);
    this.state = parsed ?? defaultState();
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state === null) return;
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  async clear(): Promise<void> {
    this.state = defaultState();
    await rm(this.stateFile, { force: true });
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

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

