import path from 'node:path';

import {
  Agent,
  AgentContext,
  CancelTaskTool,
  FileEditorTool,
  FinishTool,
  GlobTool,
  GrepTool,
  ListTasksTool,
  PauseTaskTool,
  ResumeTaskTool,
  ScheduleTaskTool,
  SendMessageTool,
  SendMediaTool,
  UpdateTaskTool,
  TerminalTool,
  ThinkTool,
  SwitchLLMTool,
  createClientFromProfile,
  llmProfileSchema,
  validateAgentSettings,
  type LLMClient,
  type LLMProfile,
  type SecretStore,
  type ToolDefinition,
} from '@smolpaws/openhands-agent';

import type { AgentFactory, AgentFactoryContext } from './eventService.js';
import { publicStartConversationRequestSchema, startConversationRequestSchema, type StartConversationRequest } from './models.js';
import type { ServerStateService } from './serverState.js';
import type { ProfileSelectionResolver } from './profileRuntime.js';
import { materializeProfileCondenser } from './condenserBinding.js';
import { materializeProfileHardCondenser } from './hardCondenserBinding.js';

export type ProfileLlmClientFactory = (profile: LLMProfile, secretStore: SecretStore) => Promise<LLMClient>;

export type ProfileToolConfigurator = (tools: readonly ToolDefinition[], context: AgentFactoryContext) => readonly ToolDefinition[];

/** Compose deployment-owned context after profile resolution and launch additions. */
export type ProfileContextConfigurator = (existingContext: AgentContext | null, factoryContext: AgentFactoryContext) => AgentContext | null | Promise<AgentContext | null>;

interface ProfileAgentFactoryOptions {
  readonly configureTools?: ProfileToolConfigurator;
  readonly configureContext?: ProfileContextConfigurator;
  readonly state: ServerStateService;
  readonly secretStore: SecretStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
  readonly resolveCondenserProfileSelection?: ProfileSelectionResolver;
}

const defaultToolNames = ['terminal', 'file_editor', 'glob', 'grep', 'finish', 'think'] as const;

/**
 * Upstream applies `agent_launch_additions.system_message_suffix_append` after agent/profile resolution by
 * appending it to the resolved agent's system-message suffix. Profile-resolved TS agents start with no
 * context, so the appended text becomes the suffix.
 */
export function launchAdditionsSuffix(request: StartConversationRequest): string | null {
  const additions = request.agent_launch_additions;
  const text = additions?.system_message_suffix_append?.trim() ?? '';
  return text.length > 0 ? text : null;
}

export function createProfileAgentFactory(options: ProfileAgentFactoryOptions): AgentFactory {
  const createLlmClient = options.llmClientFactory ?? createClientFromProfile;
  return async (requestAgent, context) => {
    const settings = validateAgentSettings(requestAgent ?? (await options.state.settings()).agent_settings);
    if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
    const profile = await resolveProfileForConversation(context.stored.request, settings.llm_profile_ref, options.state);
    const workingDir = path.resolve(context.stored.workspace.working_dir);
    // `tools` is nullable in the SDK schema: `null` (unset) and `[]` both mean "use the
    // server default set", preserving the behavior of the previous non-nullable default.
    const configuredTools = settings.tools ?? [];
    const toolSpecs = configuredTools.length === 0 ? defaultToolNames : configuredTools;
    const explicitSwitch = toolSpecs.some((spec) => toolName(spec) === 'switch_llm');
    const resolvedTools = toolSpecs.flatMap((spec) => toolName(spec) === 'switch_llm' ? [] : resolveProfileTool(spec, workingDir));
    if (explicitSwitch || settings.enable_switch_llm_tool && context.switchProfile !== undefined) {
      resolvedTools.push(SwitchLLMTool.create({
        profileNames: (await options.state.listProfiles()).profiles.map((candidate) => candidate.profileId),
        ...(context.switchProfile === undefined ? {} : { switchProfile: context.switchProfile }),
      }));
    }
    const tools = options.configureTools?.(resolvedTools, context) ?? resolvedTools;
    const suffix = launchAdditionsSuffix(context.stored.request);
    const existingContext = suffix === null ? null : new AgentContext({ systemMessageSuffix: suffix });
    const agentContext = options.configureContext === undefined
      ? existingContext
      : await options.configureContext(existingContext, context);
    const llm = context.llmClient ?? await createLlmClient(profile, options.secretStore);
    const condenser = await materializeProfileCondenser(settings.condenser, llm, context, {
      agentSettings: settings,
      getProfile: (name) => options.state.getProfile(name),
      createClient: (selected) => createLlmClient(selected, options.secretStore),
      ...(options.resolveCondenserProfileSelection === undefined ? {} : { resolveProfileSelection: options.resolveCondenserProfileSelection }),
    });
    const hardCondenser = await materializeProfileHardCondenser(settings.hard_condenser, context, {
      agentSettings: settings,
      getProfile: (name) => options.state.getProfile(name),
      createClient: (selected) => createLlmClient(selected, options.secretStore),
    });
    return new Agent({
      llm,
      condenser,
      hardCondenser,
      tools,
      toolConcurrencyLimit: settings.tool_concurrency_limit,
      ...(agentContext === null ? {} : { context: agentContext }),
    });
  };
}

export async function prepareProfileStartRequest(input: unknown, state: ServerStateService): Promise<StartConversationRequest> {
  const request = publicStartConversationRequestSchema.parse(input);
  const hasRequestedMaxIterations = isRecord(input) && Object.hasOwn(input, 'max_iterations');
  const settings = await state.settings();
  const agentSettings = validateAgentSettings(request.agent ?? settings.agent_settings);
  if (agentSettings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
  const profile = await state.getProfile(agentSettings.llm_profile_ref);
  if (profile === null) throw new Error(`llm_profile_not_found:${agentSettings.llm_profile_ref}`);
  return startConversationRequestSchema.parse({
    ...request,
    agent: agentSettings,
    llm_profile_snapshot: snapshotProfile(profile),
    ...(hasRequestedMaxIterations ? {} : { max_iterations: settings.conversation_settings.max_iterations }),
  });
}

async function resolveProfileForConversation(request: StartConversationRequest, profileId: string, state: ServerStateService): Promise<LLMProfile> {
  const snapshot = request.llm_profile_snapshot;
  if (snapshot !== undefined) {
    const parsed = llmProfileSchema.parse(snapshot);
    if (parsed.profileId !== profileId) {
      throw new Error(`llm_profile_snapshot_mismatch:${profileId}`);
    }
    return snapshotProfile(parsed);
  }
  const profile = await state.getProfile(profileId);
  if (profile === null) throw new Error(`llm_profile_not_found:${profileId}`);
  return snapshotProfile(profile);
}

function snapshotProfile(profile: LLMProfile): LLMProfile {
  return llmProfileSchema.parse(JSON.parse(JSON.stringify(profile)));
}


export function resolveProfileTool(spec: unknown, workingDir: string): readonly ToolDefinition[] {
  const name = toolName(spec);
  switch (name) {
    case 'terminal': return [TerminalTool.create({ workingDir })];
    case 'file_editor': return [FileEditorTool.create({ workspaceRoot: workingDir })];
    case 'glob': return [GlobTool.create({ workingDir })];
    case 'grep': return [GrepTool.create({ workingDir })];
    case 'finish': return [FinishTool.create()];
    case 'think': return [ThinkTool.create()];
    case 'switch_llm': return [SwitchLLMTool.create()];
    // SmolPaws additive tools (EXT-SDK-001/002). Pure ActionEvent emitters; delivery and
    // scheduling are owned downstream by the coordinator/scheduler, not the server.
    case 'send_media': return [SendMediaTool.create()];
    case 'update_task': return [UpdateTaskTool.create()];
    case 'send_message': return [SendMessageTool.create()];
    case 'schedule_task': return [ScheduleTaskTool.create()];
    case 'list_tasks': return [ListTasksTool.create()];
    case 'pause_task': return [PauseTaskTool.create()];
    case 'resume_task': return [ResumeTaskTool.create()];
    case 'cancel_task': return [CancelTaskTool.create()];
    default: throw new Error(`unsupported_profile_tool:${name}`);
  }
}

function toolName(spec: unknown): string {
  if (typeof spec === 'string' && spec.length > 0) return spec;
  if (isRecord(spec) && typeof spec.name === 'string' && spec.name.length > 0) return spec.name;
  throw new Error('invalid_profile_tool');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
