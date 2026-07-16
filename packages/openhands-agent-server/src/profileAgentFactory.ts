import path from 'node:path';

import {
  Agent,
  FileEditorTool,
  FinishTool,
  GlobTool,
  GrepTool,
  TerminalTool,
  ThinkTool,
  createClientFromProfile,
  llmProfileSchema,
  validateAgentSettings,
  type LLMClient,
  type LLMProfile,
  type SecretStore,
  type ToolDefinition,
} from '@smolpaws/openhands-agent';

import type { AgentFactory } from './eventService.js';
import { startConversationRequestSchema, type StartConversationRequest } from './models.js';
import type { ServerStateService } from './serverState.js';

export type ProfileLlmClientFactory = (profile: LLMProfile, secretStore: SecretStore) => Promise<LLMClient>;

interface ProfileAgentFactoryOptions {
  readonly state: ServerStateService;
  readonly secretStore: SecretStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
}

const defaultToolNames = ['terminal', 'file_editor', 'glob', 'grep', 'finish', 'think'] as const;

export function createProfileAgentFactory(options: ProfileAgentFactoryOptions): AgentFactory {
  const createLlmClient = options.llmClientFactory ?? createClientFromProfile;
  return async (requestAgent, context) => {
    const settings = validateAgentSettings(requestAgent ?? (await options.state.settings()).agent_settings);
    if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
    const profile = await resolveProfileForConversation(context.stored.request, settings.llm_profile_ref, options.state);
    const workingDir = path.resolve(context.stored.workspace.working_dir);
    const toolSpecs = settings.tools.length === 0 ? defaultToolNames : settings.tools;
    return new Agent({
      llm: await createLlmClient(profile, options.secretStore),
      tools: toolSpecs.flatMap((spec) => resolveProfileTool(spec, workingDir)),
      toolConcurrencyLimit: settings.tool_concurrency_limit,
    });
  };
}

export async function prepareProfileStartRequest(input: unknown, state: ServerStateService): Promise<StartConversationRequest> {
  const request = isRecord(input) ? input : {};
  const settings = await state.settings();
  const agentSettings = validateAgentSettings(request.agent ?? settings.agent_settings);
  if (agentSettings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
  const profile = await state.getProfile(agentSettings.llm_profile_ref);
  if (profile === null) throw new Error(`llm_profile_not_found:${agentSettings.llm_profile_ref}`);
  return startConversationRequestSchema.parse({
    ...request,
    agent: agentSettings,
    llm_profile_snapshot: snapshotProfile(profile),
    ...(request.max_iterations === undefined ? { max_iterations: settings.conversation_settings.max_iterations } : {}),
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


function resolveProfileTool(spec: unknown, workingDir: string): readonly ToolDefinition[] {
  const name = toolName(spec);
  switch (name) {
    case 'terminal': return [TerminalTool.create({ workingDir })];
    case 'file_editor': return [FileEditorTool.create({ workspaceRoot: workingDir })];
    case 'glob': return [GlobTool.create({ workingDir })];
    case 'grep': return [GrepTool.create({ workingDir })];
    case 'finish': return [FinishTool.create()];
    case 'think': return [ThinkTool.create()];
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
