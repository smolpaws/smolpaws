import {
  CancelTaskTool, FileEditorTool, GlobTool, GrepTool, ListTasksTool, PauseTaskTool,
  ResumeTaskTool, ScheduleTaskTool, SendMessageTool, SendMediaTool, TerminalTool, UpdateTaskTool,
  NATIVE_TOOL_MODULE_QUALNAMES, createClientFromProfile, globalToolRegistry, resolveTool,
  type ClassifyAndSwitchLLMToolOptions, type LaunchRuntime, type LLMProfile,
  type MetaProfileStore, type SecretStore, type ToolDefinition, type ToolSpec,
} from '@smolpaws/openhands-agent';
import type { AgentFactoryContext } from './eventService.js';
import type { ProfileLlmClientFactory } from './profileAgentFactory.js';
import type { ServerStateService } from './serverState.js';

interface NativeToolContext { readonly workingDir: string; readonly persistenceDir?: string | null }
const factories: Readonly<Record<string, (context: NativeToolContext) => ToolDefinition>> = {
  terminal: context => TerminalTool.create({ workingDir: context.workingDir }),
  file_editor: context => FileEditorTool.create({ workspaceRoot: context.workingDir }),
  glob: context => GlobTool.create({ workingDir: context.workingDir }),
  grep: context => GrepTool.create({ workingDir: context.workingDir }),
  send_media: () => SendMediaTool.create(), update_task: () => UpdateTaskTool.create(),
  send_message: () => SendMessageTool.create(), schedule_task: () => ScheduleTaskTool.create(),
  list_tasks: () => ListTasksTool.create(), pause_task: () => PauseTaskTool.create(),
  resume_task: () => ResumeTaskTool.create(), cancel_task: () => CancelTaskTool.create(),
};
const descriptions: Readonly<Record<string, string>> = {
  terminal: 'Run shell commands in the conversation workspace.', file_editor: 'Read and edit files.',
  glob: 'Find paths matching a pattern.', grep: 'Search file contents.',
};

/** Register implementations, never conversation-bound tool instances or factory probes. */
export function ensureProfileToolsRegistered(): void {
  const registered = new Set(globalToolRegistry.listRegisteredTools());
  for (const [name, create] of Object.entries(factories)) {
    if (registered.has(name)) continue;
    const moduleQualname = NATIVE_TOOL_MODULE_QUALNAMES[name as keyof typeof NATIVE_TOOL_MODULE_QUALNAMES];
    globalToolRegistry.registerFactory(name, (params, context) => {
      if (Object.keys(params).length > 0) throw new Error(`Unsupported native tool parameters: ${name}`);
      if (!isNativeContext(context)) throw new Error('Native tool requires a workspace context');
      return [create(context)];
    }, { catalogDescription: descriptions[name] ?? `SmolPaws ${name.replaceAll('_', ' ')} tool.`,
      ...(moduleQualname === undefined ? {} : { moduleQualname }) });
  }
}

export interface ProfileToolMaterializerOptions {
  readonly state: ServerStateService;
  readonly secretStore: SecretStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
  readonly metaProfileStore?: Pick<MetaProfileStore, 'list' | 'load'>;
  readonly workingDir: string;
  readonly persistenceDir?: string | null;
  readonly context?: AgentFactoryContext;
  readonly onResolvedTool?: (spec: ToolSpec, tool: ToolDefinition, moduleQualname: string | undefined) => void;
  readonly materializeMcpTools?: (config: Readonly<Record<string, unknown>>) => Promise<readonly ToolDefinition[]>;
}

export function createProfileToolMaterializer(options: ProfileToolMaterializerOptions): NonNullable<LaunchRuntime['materializeTools']> {
  ensureProfileToolsRegistered();
  const createClient = options.llmClientFactory ?? createClientFromProfile;
  return async (specs, launch) => {
    const rawMcp = launch.settings.mcp_config;
    if (rawMcp !== null && rawMcp !== undefined && (typeof rawMcp !== 'object' || Array.isArray(rawMcp))) throw new Error('Invalid MCP configuration');
    const mcp = rawMcp as Record<string, unknown> | null | undefined;
    if (mcp !== null && mcp !== undefined && Object.keys(mcp).length > 0 && options.materializeMcpTools === undefined) {
      throw new Error('Native MCP execution requires an explicitly supplied host materializer');
    }
    const tools: ToolDefinition[] = [];
    for (const spec of specs) {
      const start = tools.length;
      const builtin = globalToolRegistry.effectiveBuiltinName(spec.name);
      if (builtin === 'switch_llm') {
        tools.push(...resolveTool(spec, {
          profileNames: (await options.state.listProfiles()).profiles.map(profile => profile.profileId),
          ...(options.context?.switchProfile === undefined ? {} : { switchProfile: options.context.switchProfile }),
        }));
      } else if (builtin === 'route_task_to_model') {
        const context = options.context;
        const binding: ClassifyAndSwitchLLMToolOptions = {
          activeMetaProfile: launch.settings.active_meta_profile,
          metaProfile: launch.settings.meta_profile,
          metaProfileLlms: launch.settings.meta_profile_llms,
          metaProfileStore: options.metaProfileStore ?? options.state.metaProfileStore,
          ...(context?.state === undefined || context.switchProfile === undefined || context.getLLMCallContext === undefined ? {} : { runtime: {
            state: context.state, getCallContext: context.getLLMCallContext,
            listProfileNames: async () => (await options.state.listProfiles()).profiles.map(profile => profile.profileId),
            resolveClient: async (name: string, inline?: LLMProfile) => {
              const profile = inline ?? await options.state.getProfile(name);
              if (profile === null) throw new Error(`llm_profile_not_found:${name}`);
              return createClient({ ...structuredClone(profile), profileId: name }, options.secretStore);
            },
            switchProfile: context.switchProfile,
          } }),
        };
        tools.push(...resolveTool(spec, binding));
      } else tools.push(...resolveTool(spec, { workingDir: options.workingDir, persistenceDir: options.persistenceDir ?? null }));
      const moduleQualname = globalToolRegistry.getToolModuleQualnames([spec.name])[spec.name];
      for (const tool of tools.slice(start)) options.onResolvedTool?.(spec, tool, moduleQualname);
    }
    if (mcp !== null && mcp !== undefined && Object.keys(mcp).length > 0 && options.materializeMcpTools !== undefined) tools.push(...await options.materializeMcpTools(mcp));
    return tools;
  };
}

/** Compatibility entry point for hosts that construct one workspace-bound tool. */
export function resolveProfileTool(spec: ToolSpec, workingDir: string): readonly ToolDefinition[] {
  ensureProfileToolsRegistered();
  return resolveTool(spec, { workingDir, persistenceDir: null });
}
function isNativeContext(value: unknown): value is NativeToolContext {
  return typeof value === 'object' && value !== null && 'workingDir' in value && typeof value.workingDir === 'string';
}
