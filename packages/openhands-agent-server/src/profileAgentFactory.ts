import path from 'node:path';
import {
  AgentContext, ResolvedLaunch, createClientFromProfile, finalizeLaunch, llmProfileSchema,
  toolSpecSchema, validateAgentSettings,
  type CreateLlmClientOptions, type LLMClient, type LLMProfile, type MetaProfileStore,
  type SecretStore, type ToolDefinition,
} from '@smolpaws/openhands-agent';
import type { AgentFactory, AgentFactoryContext } from './eventService.js';
import type { StartConversationRequest } from './models.js';
import type { ServerStateService } from './serverState.js';
import type { ProfileSelectionResolver } from './profileRuntime.js';
import { captureProfileCondenserBinding } from './condenserBinding.js';
import { captureProfileHardCondenserBinding } from './hardCondenserBinding.js';
import { createProfileToolMaterializer, resolveProfileTool as resolveNativeProfileTool, type ProfileToolMaterializerOptions } from './profileTools.js';
import { prepareServerStartRequest, resolvePreparedLaunch, restoreResolvedLaunch, type ServerLaunchOptions } from './launch.js';
import { conversationDirectory } from './conversationMetadata.js';
import { getDefaultConfig } from './config.js';
import { mergeToolModuleQualnames } from './toolModuleProvenance.js';

export type ProfileLlmClientFactory = (profile: LLMProfile, secretStore: SecretStore, options?: CreateLlmClientOptions) => Promise<LLMClient>;
export type ProfileToolConfigurator = (tools: readonly ToolDefinition[], context: AgentFactoryContext) => readonly ToolDefinition[];
/** Compose deployment-owned context after profile resolution and launch additions. */
export type ProfileContextConfigurator = (existingContext: AgentContext | null, factoryContext: AgentFactoryContext) => AgentContext | null | Promise<AgentContext | null>;
interface ProfileAgentFactoryOptions {
  readonly configureTools?: ProfileToolConfigurator;
  readonly configureContext?: ProfileContextConfigurator;
  readonly state: ServerStateService;
  readonly secretStore: SecretStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
  readonly metaProfileStore?: Pick<MetaProfileStore, 'list' | 'load'>;
  readonly resolveCondenserProfileSelection?: ProfileSelectionResolver;
  readonly conversationsPath?: string;
  readonly materializeMcpTools?: ProfileToolMaterializerOptions['materializeMcpTools'];
}

export function launchAdditionsSuffix(request: StartConversationRequest): string | null {
  const text = request.agent_launch_additions?.system_message_suffix_append?.trim() ?? '';
  return text.length > 0 ? text : null;
}

export function createProfileAgentFactory(options: ProfileAgentFactoryOptions): AgentFactory {
  const createLlmClient = options.llmClientFactory ?? createClientFromProfile;
  return async (requestAgent, context) => {
    if (context.stored.request.launch_source !== undefined) {
      if (context.updateRequest === undefined) throw new Error('launch_snapshot_persistence_required');
      const previous = context.stored.request;
      const guard = launchIdentity(previous);
      const reference = await options.resolveCondenserProfileSelection?.(context);
      const completed = await resolvePreparedLaunch(previous, options.state,
        reference === undefined ? {} : { defaultCondenserProfileRef: reference });
      await context.updateRequest(current => {
        if (current.launch_source === undefined) return current;
        if (launchIdentity(current) !== guard) throw new Error('launch_configuration_changed_during_capture');
        const next = { ...current, agent: completed.agent, llm_profile_snapshot: completed.llm_profile_snapshot, resolved_launch: completed.resolved_launch };
        delete next.launch_source;
        return next;
      });
    }
    const initial = restoreResolvedLaunch(context.stored.request);
    const settings = initial?.settings ?? validateAgentSettings(context.stored.request.agent ?? requestAgent ?? (await options.state.settings()).agent_settings);
    if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
    const profile = initial?.bindings.main ?? initial?.llmProfiles[settings.llm_profile_ref]
      ?? await resolveProfileForConversation(context.stored.request, settings.llm_profile_ref, options.state);
    const llm = context.llmClient ?? await createLlmClient(profile, options.secretStore);
    const condenser = await captureProfileCondenserBinding(settings.condenser, llm, context, {
      agentSettings: settings,
      getProfile: name => initial?.bindings.condenser?.profileId === name ? Promise.resolve(initial.bindings.condenser) : options.state.getProfile(name),
      createClient: selected => createLlmClient(selected, options.secretStore),
      ...(options.resolveCondenserProfileSelection === undefined ? {} : { resolveProfileSelection: options.resolveCondenserProfileSelection }),
    });
    const hard = await captureProfileHardCondenserBinding(settings.hard_condenser, context, {
      agentSettings: settings,
      getProfile: name => initial?.bindings.hard_condenser?.profileId === name ? Promise.resolve(initial.bindings.hard_condenser) : options.state.getProfile(name),
      createClient: selected => createLlmClient(selected, options.secretStore),
    });
    const resolved = new ResolvedLaunch({
      settings: { ...settings, ...(condenser === null ? {} : { condenser: condenser.settings }), ...(hard === null ? {} : { hard_condenser: hard.settings }) },
      llmProfiles: initial?.llmProfiles ?? { [profile.profileId]: profile },
      context: initial?.context ?? null, profile: initial?.profile ?? null,
      bindings: { ...initial?.bindings, main: profile, ...(condenser === null ? {} : { condenser: condenser.profile }), ...(hard === null ? {} : { hard_condenser: hard.profile }) },
    });
    const identities = new Map<ToolDefinition, { name: string; module: string }>();
    const materializeTools = createProfileToolMaterializer({
      state: options.state, secretStore: options.secretStore, llmClientFactory: createLlmClient,
      ...(options.metaProfileStore === undefined ? {} : { metaProfileStore: options.metaProfileStore }),
      workingDir: path.resolve(context.stored.workspace.working_dir),
      persistenceDir: conversationDirectory(context.stored, options.conversationsPath ?? getDefaultConfig().conversationsPath), context,
      ...(options.materializeMcpTools === undefined ? {} : { materializeMcpTools: options.materializeMcpTools }),
      onResolvedTool: (spec, tool, module) => { if (module !== undefined) identities.set(tool, { name: spec.name, module }); },
    });
    const launched = await finalizeLaunch(resolved, {
      createClient: (selected, role) => role === 'main' ? llm : createLlmClient(selected, options.secretStore), materializeTools,
    }, { additions: context.stored.request.agent_launch_additions ?? null });
    const tools = options.configureTools?.(launched.agent.tools, context) ?? launched.agent.tools;
    const agentContext = options.configureContext === undefined ? launched.agent.context : await options.configureContext(launched.agent.context ?? null, context);
    if (context.updateRequest !== undefined && context.stored.request.resolved_launch !== undefined) {
      const trusted = Object.fromEntries(tools.flatMap(tool => { const record = identities.get(tool); return record === undefined ? [] : [[record.name, record.module]]; }));
      const clientNames = context.stored.request.client_tools.flatMap(tool => typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string' ? [tool.name] : []);
      const mapping = mergeToolModuleQualnames(context.stored.request.tool_module_qualnames, trusted, clientNames);
      if (JSON.stringify(mapping) !== JSON.stringify(context.stored.request.tool_module_qualnames)) await context.updateRequest(request => ({ ...request, tool_module_qualnames: mergeToolModuleQualnames(request.tool_module_qualnames, trusted, clientNames) }));
    }
    return launched.agent.withOverrides({ tools, context: agentContext ?? null });
  };
}

export async function prepareProfileStartRequest(input: unknown, state: ServerStateService, options: ServerLaunchOptions = {}): Promise<StartConversationRequest> {
  return prepareServerStartRequest(input, state, options);
}
async function resolveProfileForConversation(request: StartConversationRequest, profileId: string, state: ServerStateService): Promise<LLMProfile> {
  const snapshot = request.llm_profile_snapshot;
  if (snapshot !== undefined) {
    const parsed = llmProfileSchema.parse(snapshot);
    if (parsed.profileId !== profileId) throw new Error(`llm_profile_snapshot_mismatch:${profileId}`);
    return structuredClone(parsed);
  }
  const profile = await state.getProfile(profileId);
  if (profile === null) throw new Error(`llm_profile_not_found:${profileId}`);
  return structuredClone(profile);
}
export function resolveProfileTool(spec: unknown, workingDir: string): readonly ToolDefinition[] {
  return resolveNativeProfileTool(toolSpecSchema.parse(typeof spec === 'string' ? { name: spec } : spec), workingDir);
}
function launchIdentity(request: StartConversationRequest): string {
  return JSON.stringify([request.agent, request.llm_profile_snapshot, request.resolved_launch, request.launch_source]);
}
