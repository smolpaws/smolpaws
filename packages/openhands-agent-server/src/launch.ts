import {
  AgentLaunchError, LaunchStoreError, ProfileNotFound, ResolvedLaunch, Skill, UnresolvedProfileReferences,
  previewLaunch, resolveLaunch, resolveSettingsLaunch, skillSchema, validateAgentProfile, validateAgentSettings,
  type AgentContextOptions, type AgentProfile, type AgentProfileDiagnostics, type LaunchLlmBindings,
  type LaunchRuntime, type LaunchStores, type LLMClient, type OpenHandsAgentSettings, type OpenHandsAgentProfile,
} from '@smolpaws/openhands-agent';
import { publicStartConversationRequestSchema, resolvedLaunchSnapshotSchema, startConversationRequestSchema,
  type ResolvedLaunchSnapshot, type StartConversationRequest } from './models.js';
import type { ServerStateService } from './serverState.js';

export interface ServerLaunchOptions {
  readonly defaultCondenserProfileRef?: string;
  readonly deferCondenserResolution?: boolean;
  readonly skills?: () => Promise<readonly Skill[]> | readonly Skill[];
}

export async function serverLaunchStores(state: ServerStateService, options: ServerLaunchOptions = {}): Promise<LaunchStores> {
  const settings = await readLaunchStore(() => state.agentSettings(), 'Could not load launch settings');
  return {
    llmProfiles: { load: name => state.getProfile(name) },
    llmProfileNames: async () => (await state.listProfiles()).profiles.map(profile => profile.profileId),
    agentProfiles: { nameForId: async id => (await state.getAgentProfileById(id))?.name ?? null, load: name => state.getAgentProfile(name) },
    mcpConfig: typeof settings.mcp_config === 'object' && settings.mcp_config !== null && !Array.isArray(settings.mcp_config) ? settings.mcp_config as Record<string, unknown> : {}, skills: options.skills ?? (() => []), metaProfiles: state.metaProfileStore,
    ...(options.defaultCondenserProfileRef === undefined ? {} : { defaultCondenserProfileRef: options.defaultCondenserProfileRef }),
  };
}

/** Resolve before materialization; this performs no client construction or completion. */
export async function prepareServerStartRequest(input: unknown, state: ServerStateService, options: ServerLaunchOptions = {}): Promise<StartConversationRequest> {
  const request = publicStartConversationRequestSchema.parse(input);
  const defaults = await readLaunchStore(() => state.launchSettings(), 'Could not load launch settings');
  const stores = await serverLaunchStores(state, options);
  let profile: OpenHandsAgentProfile | undefined;
  let settings: OpenHandsAgentSettings;
  if (request.agent_profile_id !== undefined && request.agent_profile_id !== null) {
    const id = request.agent_profile_id;
    const loaded = await readLaunchStore(() => state.getAgentProfileById(id), 'Could not load agent profile');
    if (loaded === null) throw new ProfileNotFound('Agent profile not found');
    const validated = validateAgentProfile(structuredClone(loaded));
    if (validated.agent_kind !== 'openhands') throw new AgentLaunchError('ACP runtime is not supported');
    profile = validated;
    // The SDK still owns profile projection; this validates only the condenser
    // input needed to stage the host's context-dependent missing selection.
    settings = nativeSettings({ llm_profile_ref: profile.llm_profile_ref, condenser: profile.condenser });
  } else settings = nativeSettings(request.agent ?? request.agent_settings ?? defaults.agent_settings);
  const condenser = settings.condenser;
  const staged = options.deferCondenserResolution === true && options.defaultCondenserProfileRef === undefined
    && condenser.enabled && condenser.condenser_kind === 'llm_summarizing' && condenser.llm_profile_ref === undefined;
  let resolved: ResolvedLaunch;
  if (profile !== undefined) resolved = await resolveLaunch(staged ? { ...profile, condenser: { ...condenser, enabled: false } } : profile, stores);
  else resolved = await resolveSettingsLaunch(staged ? { ...settings, condenser: { ...condenser, enabled: false } } : settings, stores);
  if (staged) resolved = new ResolvedLaunch({ settings: { ...resolved.settings, condenser }, llmProfiles: resolved.llmProfiles,
    profile: resolved.profile, context: resolved.context });
  const prepared = publishResolved(request, resolved);
  const allowed = resolved.allowedSecrets;
  return startConversationRequestSchema.parse({ ...prepared,
    ...(staged ? { launch_source: { kind: 'missing_condenser_ref' } } : {}),
    ...(request.secrets === undefined || allowed === null ? {} : { secrets: Object.fromEntries(Object.entries(request.secrets).filter(([name]) => allowed.has(name))) }),
    ...((typeof input === 'object' && input !== null && Object.hasOwn(input, 'max_iterations')) ? {} : { max_iterations: defaults.conversation_settings.max_iterations }),
  });
}

/** Complete ONLY the deferred role, keeping every already captured input fixed. */
export async function resolvePreparedLaunch(request: StartConversationRequest, state: ServerStateService, options: Pick<ServerLaunchOptions, 'defaultCondenserProfileRef'> = {}): Promise<StartConversationRequest> {
  if (request.launch_source === undefined) return request;
  const resolved = restoreResolvedLaunch(request);
  if (resolved === null) throw new AgentLaunchError('Staged launch snapshot is missing');
  const condenser = resolved.settings.condenser;
  if (!condenser.enabled || condenser.condenser_kind !== 'llm_summarizing') throw new AgentLaunchError('Staged condenser settings changed');
  const ref = condenser.llm_profile_ref ?? options.defaultCondenserProfileRef;
  if (!ref) throw new AgentLaunchError('Enabled LLM condenser requires an explicit profile reference');
  // A role can share the main profile ID yet require an independent snapshot.
  let selected = resolved.bindings.condenser;
  if (selected === undefined) {
    let loaded;
    try { loaded = await state.getProfile(ref); }
    catch { throw new LaunchStoreError('Could not load condenser LLM profile'); }
    if (loaded === null) throw new UnresolvedProfileReferences({ condenserLlmRefs: [ref] });
    selected = loaded;
  }
  if (selected.profileId !== ref) throw new AgentLaunchError('Condenser profile snapshot does not match its reference');
  const completed = new ResolvedLaunch({ settings: { ...resolved.settings, condenser: { ...condenser, llm_profile_ref: ref } },
    llmProfiles: resolved.llmProfiles, context: resolved.context, profile: resolved.profile,
    bindings: { ...resolved.bindings, condenser: selected } });
  const next = publishResolved(request, completed);
  delete next.launch_source;
  return next;
}

/** Reattachment/finalization never rereads the mutable profile stores. */
export function restoreResolvedLaunch(request: StartConversationRequest): ResolvedLaunch | null {
  if (request.resolved_launch === undefined) return null;
  const snapshot = resolvedLaunchSnapshotSchema.parse(request.resolved_launch);
  let settings = nativeSettings(request.agent);
  if (request.condenser_binding !== undefined) settings = { ...settings, condenser: request.condenser_binding.settings };
  if (request.hard_condenser_binding !== undefined) settings = { ...settings, hard_condenser: request.hard_condenser_binding.settings };
  const bindings: LaunchLlmBindings = { ...Object.fromEntries(Object.entries(snapshot.bindings ?? {}).filter(([, value]) => value !== undefined)),
    ...(request.llm_profile_snapshot === undefined ? {} : { main: request.llm_profile_snapshot }),
    ...(request.condenser_binding === undefined ? {} : { condenser: request.condenser_binding.profile }),
    ...(request.hard_condenser_binding === undefined ? {} : { hard_condenser: request.hard_condenser_binding.profile }),
  };
  return new ResolvedLaunch({ settings, llmProfiles: snapshot.llm_profiles, bindings, profile: snapshot.profile,
    context: snapshot.context === null ? null : { ...snapshot.context, skills: snapshot.context.skills.map(value => skillSchema.parse(value)) } });
}

function publishResolved(request: StartConversationRequest, resolved: ResolvedLaunch): StartConversationRequest {
  const settings = resolved.settings;
  const main = resolved.bindings.main ?? resolved.llmProfiles[settings.llm_profile_ref];
  if (main === undefined) throw new AgentLaunchError('Main LLM profile snapshot is missing');
  const condenserRef = settings.condenser.enabled && settings.condenser.condenser_kind === 'llm_summarizing' ? settings.condenser.llm_profile_ref : undefined;
  const hardRef = settings.hard_condenser?.llm_profile_ref;
  const bindings: LaunchLlmBindings = { main,
    ...(condenserRef !== undefined && resolved.llmProfiles[condenserRef] !== undefined ? { condenser: resolved.llmProfiles[condenserRef] } : {}),
    ...(hardRef !== undefined && resolved.llmProfiles[hardRef] !== undefined ? { hard_condenser: resolved.llmProfiles[hardRef] } : {}),
    ...resolved.bindings };
  const snapshot: ResolvedLaunchSnapshot = resolvedLaunchSnapshotSchema.parse({ llm_profiles: resolved.llmProfiles,
    context: serializeContext(resolved.context), profile: resolved.profile, bindings });
  return startConversationRequestSchema.parse({ ...request, agent: settings, agent_settings: undefined,
    llm_profile_snapshot: main, resolved_launch: snapshot });
}

function serializeContext(context: AgentContextOptions | null): unknown {
  if (context === null) return null;
  return { ...context, currentDatetime: context.currentDatetime instanceof Date ? context.currentDatetime.toISOString() : context.currentDatetime,
    secrets: context.secrets === null || context.secrets === undefined ? null : Object.fromEntries(Object.entries(context.secrets).map(([name, value]) => [name, { description: typeof value === 'object' ? value.description ?? null : null }])) };
}
function nativeSettings(input: unknown): OpenHandsAgentSettings {
  let settings;
  try { settings = validateAgentSettings(input); }
  catch { throw new AgentLaunchError('Invalid agent settings'); }
  if (settings.agent_kind !== 'openhands') throw new AgentLaunchError('ACP runtime is not supported');
  return settings;
}

async function readLaunchStore<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch { throw new LaunchStoreError(message); }
}

export async function previewServerProfile(profile: AgentProfile, state: ServerStateService, runtime: LaunchRuntime, options: ServerLaunchOptions = {}): Promise<AgentProfileDiagnostics> {
  return previewLaunch(profile, await serverLaunchStores(state, options), runtime);
}

/** Preview has no credentials, network discovery, completions, or durable state. */
export function previewClient(profile: Parameters<LaunchRuntime['createClient']>[0]): LLMClient {
  return { profile, effectiveMaxInputTokens: profile.maxInputTokens,
    async complete() { throw new AgentLaunchError('Preview cannot make LLM completions'); } };
}

export function launchHttpError(error: unknown): { statusCode: number; detail: unknown } | null {
  if (error instanceof ProfileNotFound) return { statusCode: 404, detail: error.toDetail() };
  if (error instanceof AgentLaunchError) return { statusCode: 422, detail: error.toDetail() };
  if (error instanceof LaunchStoreError) return { statusCode: error.retryable ? 503 : 500, detail: error.message };
  return null;
}
