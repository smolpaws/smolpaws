import os from "node:os";
import path from "node:path";
import {
  AgentContext,
  BrowserTool,
  LLMSecurityAnalyzer,
  LocalConversation,
  SecretRegistry,
  Workspace,
  clearRawLlmFieldsWhenProfileSelected,
  createConfirmationPolicyFromSettings,
  type Event,
  type OpenHandsSettings,
  type TextContent,
  type ToolDefinition,
} from "@smolpaws/agent-sdk";
import {
  buildConversationDirPath,
  buildConversationInfoFromPersistence,
  hasPersistedConversation,
  isSafeConversationId,
  readPersistedConversationMeta,
  writeConversationMeta,
  type ConversationRecord,
} from "../runner/conversationService.js";
import {
  deriveExecutionStatusFromEvents,
  hasQueuedUserMessage,
} from "../runner/conversationState.js";
import { readPersistedEventsOrThrow } from "../runner/eventService.js";
import {
  getConfiguredWorkspaceRoot,
  getConfiguredLlmProfileId,
  getDefaultWorkingDir,
  resolveAbsolutePersistenceRoot,
  resolvePersistenceDir,
  resolveWorkspaceRoot,
  type RunnerEnv,
} from "../runner/workspacePolicy.js";
import {
  extractMessageText,
  extractTextFromMessageRequest,
} from "../runner/messageText.js";
import {
  createCurrentThreadMessageTool,
  type RunnerOutboundMessage,
} from "../runner/outboundMessaging.js";
import { appendOutboundMessage, appendTaskCommand } from "../runner/outbox.js";
import { createTaskTools } from "../runner/taskCommands.js";
import {
  loadProjectSkills,
  resolveProjectSkillsRoot,
} from "./projectSkills.js";
import type {
  SmolpawsGithubContext,
  SmolpawsConversationConfigValue,
  SmolpawsTaskCommand,
} from "../shared/runner.js";
import type {
  SetConfirmationPolicyRequest,
  SetSecurityAnalyzerRequest,
  SetSecretsRequest,
  StartConversationRequest,
} from "./models.js";

const DEFAULT_REMOTE_TOOL_NAMES = ["terminal", "file_editor", "task_tracker"] as const;

export type EventSubscriber = (event: Event) => void;

type ConversationRuntimeArgs = {
  env: RunnerEnv;
  persistenceRoot: string;
  persistenceDir?: string;
};

type RequestedAgentTool = {
  name?: unknown;
};

type ConversationToolProfile = {
  includeDefaultTools: boolean | string[];
  tools: ToolDefinition<unknown, unknown>[];
};

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { kind?: unknown; value?: unknown };
  if (record.kind === "StaticSecret" && typeof record.value === "string") {
    const trimmed = record.value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function normalizeRequestedToolNames(
  tools: unknown,
): string[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const normalized = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return "";
      }
      const rawName = (tool as RequestedAgentTool).name;
      return typeof rawName === "string" ? rawName.trim() : "";
    })
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function buildRequestedNonDefaultTools(
  requestedToolNames: string[],
): ToolDefinition<unknown, unknown>[] {
  const tools: ToolDefinition<unknown, unknown>[] = [];
  for (const name of requestedToolNames) {
    if (name === "terminal" || name === "file_editor" || name === "task_tracker") {
      continue;
    }
    if (name === "browser") {
      tools.push(new BrowserTool());
      continue;
    }
    throw new Error(`unsupported_tool:${name}`);
  }
  return tools;
}

function shouldEnableSendMessage(
  config?: SmolpawsConversationConfigValue,
): boolean {
  return config?.enable_send_message === true;
}

function shouldEnableTaskTools(
  config?: SmolpawsConversationConfigValue,
): boolean {
  return config?.enable_task_tools === true;
}

function mergeSmolpawsConfig(
  current: SmolpawsConversationConfigValue | undefined,
  next: SmolpawsConversationConfigValue | undefined,
): SmolpawsConversationConfigValue | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    ingress: next.ingress ?? current.ingress,
    scope_id: next.scope_id ?? current.scope_id,
    is_control_scope: next.is_control_scope ?? current.is_control_scope,
    enable_send_message: next.enable_send_message ?? current.enable_send_message,
    enable_task_tools: next.enable_task_tools ?? current.enable_task_tools,
    visible_tasks: next.visible_tasks ?? current.visible_tasks,
    github: next.github ?? current.github,
  };
}

function toOptionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatGithubThread(github?: SmolpawsGithubContext): string | undefined {
  if (!github) {
    return undefined;
  }
  const issueNumber = github.issue_number;
  const prNumber = github.pull_request_number;
  if (typeof prNumber === "number" && Number.isFinite(prNumber)) {
    return `pull request #${prNumber}`;
  }
  if (typeof issueNumber === "number" && Number.isFinite(issueNumber)) {
    return `issue #${issueNumber}`;
  }
  return undefined;
}

function buildEnvironmentInformationBlock(params: {
  workspaceRoot: string;
  projectSkillsRoot: string;
  env: RunnerEnv;
  smolpawsConfig?: SmolpawsConversationConfigValue;
}): string {
  const configuredWorkspaceRoot = getConfiguredWorkspaceRoot(params.env);
  const defaultWorkingDirSetting =
    params.env.SMOLPAWS_DEFAULT_WORKING_DIR?.trim() || '.';
  const defaultWorkingDir = getDefaultWorkingDir(params.env);
  const lines = [
    "<environment information>",
    `- Repositories on this machine are typically cloned under: ${configuredWorkspaceRoot}`,
    `- The canonical SmolPaws repository on this machine is: ${path.join(os.homedir(), "repos", "smolpaws")}`,
    `- Default conversation working_dir within that root: ${defaultWorkingDirSetting}`,
    `- Resolved default startup working directory for local SmolPaws runs: ${defaultWorkingDir}`,
    `- Current resolved working directory for this conversation: ${params.workspaceRoot}`,
    `- Project/repo skills for this conversation are loaded from: ${params.projectSkillsRoot}`,
  ];

  const github = params.smolpawsConfig?.github;
  const repoFullName = toOptionalTrimmedString(github?.repository_full_name);
  const actorLogin = toOptionalTrimmedString(github?.actor_login);
  const eventName = toOptionalTrimmedString(github?.event);
  const thread = formatGithubThread(github);

  if (repoFullName || actorLogin || eventName || thread) {
    lines.push("- This run was triggered from GitHub.");
    if (repoFullName) {
      lines.push(`- GitHub repository: ${repoFullName}`);
    }
    if (thread) {
      lines.push(`- GitHub thread: ${thread}`);
    }
    if (eventName) {
      lines.push(`- GitHub event type: ${eventName}`);
    }
    if (actorLogin) {
      lines.push(`- GitHub actor: ${actorLogin}`);
    }
  }

  lines.push("</environment information>");
  return lines.join("\n");
}

function buildAgentContext(
  workspaceRoot: string,
  projectSkillsRoot: string,
  env: RunnerEnv,
  smolpawsConfig?: SmolpawsConversationConfigValue,
): AgentContext {
  return new AgentContext({
    skills: loadProjectSkills(projectSkillsRoot),
    loadUserSkills: true,
    systemMessageSuffix: buildEnvironmentInformationBlock({
      workspaceRoot,
      projectSkillsRoot,
      env,
      smolpawsConfig,
    }),
  });
}

function registerSecrets(
  secrets: Record<string, unknown> | undefined,
  registry: SecretRegistry,
  settings: OpenHandsSettings,
): void {
  if (!secrets) {
    return;
  }
  for (const [key, raw] of Object.entries(secrets)) {
    const value = normalizeSecretValue(raw);
    if (!value) continue;
    registry.register(key, value);
    if (key === "GITHUB_TOKEN") settings.secrets.githubToken = value;
    if (key === "ELEVENLABS_API_KEY") settings.secrets.halTtsApiKey = value;
    if (key === "CUSTOM_SECRET_1") settings.secrets.customSecret1 = value;
    if (key === "CUSTOM_SECRET_2") settings.secrets.customSecret2 = value;
    if (key === "CUSTOM_SECRET_3") settings.secrets.customSecret3 = value;
  }
}

function registerRuntimeEnvSecrets(
  registry: SecretRegistry,
  settings: OpenHandsSettings,
): void {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (githubToken) {
    registry.set("GITHUB_TOKEN", githubToken);
    settings.secrets.githubToken ||= githubToken;
  }
}

function buildSettingsFromRequest(
  request: StartConversationRequest,
  registry: SecretRegistry,
  env: RunnerEnv,
): OpenHandsSettings {
  const llm = request.agent.llm;
  const profileId = typeof llm.profile_id === "string"
    ? llm.profile_id.trim()
    : getConfiguredLlmProfileId(env);
  if (!profileId) {
    throw new Error("LLM profile id is required");
  }
  const settings: OpenHandsSettings = {
    llm: clearRawLlmFieldsWhenProfileSelected({
      profileId,
    }),
    agent: {
      enableSecurityAnalyzer: Boolean(request.agent.security_analyzer),
      debug: false,
      summarizeToolCalls: false,
    },
    conversation: {
      maxIterations:
        typeof request.max_iterations === "number"
          ? request.max_iterations
          : undefined,
      stuckDetection:
        typeof request.stuck_detection === "boolean"
          ? request.stuck_detection
          : undefined,
      stuckThresholds: request.stuck_detection_thresholds
        ? {
            actionObservation: request.stuck_detection_thresholds.actionObservation,
            actionError: request.stuck_detection_thresholds.actionError,
            monologue: request.stuck_detection_thresholds.monologue,
            alternatingPattern:
              request.stuck_detection_thresholds.alternatingPattern,
          }
        : undefined,
    },
    confirmation: {
      policy: "never",
      riskyThreshold: "HIGH",
      confirmUnknown: true,
    },
    secrets: {
      awsAccessKeyId: (llm as { aws_access_key_id?: string }).aws_access_key_id,
      awsSecretAccessKey: (llm as { aws_secret_access_key?: string })
        .aws_secret_access_key,
    },
  };

  if (request.confirmation_policy?.kind === "AlwaysConfirm") {
    settings.confirmation.policy = "always";
  } else if (request.confirmation_policy?.kind === "ConfirmRisky") {
    settings.confirmation.policy = "risky";
    settings.confirmation.riskyThreshold =
      request.confirmation_policy.threshold ?? "HIGH";
    settings.confirmation.confirmUnknown =
      request.confirmation_policy.confirm_unknown ?? true;
  }

  registerSecrets(request.secrets, registry, settings);
  registerRuntimeEnvSecrets(registry, settings);

  return settings;
}

export async function runStandaloneQuestion(
  settings: OpenHandsSettings,
  prompt: string,
  workspaceRoot?: string,
  persistenceDir?: string,
  options?: {
    enableOutboundMessages?: boolean;
    toolProfile?: ConversationToolProfile;
  },
): Promise<{ reply: string; outbound_messages?: RunnerOutboundMessage[] }> {
  const registry = new SecretRegistry();
  const outboundMessages: RunnerOutboundMessage[] = [];
  const requestedTools = options?.toolProfile?.tools ?? [];
  const extraTools = options?.enableOutboundMessages
    ? [createCurrentThreadMessageTool((message) => {
        outboundMessages.push(message);
      })]
    : [];
  const conversation = new LocalConversation({
    settings,
    workspace: Workspace({ kind: "local", root: workspaceRoot }),
    secrets: registry,
    tools: [...requestedTools, ...extraTools],
    includeDefaultTools: options?.toolProfile?.includeDefaultTools ?? false,
    persistenceDir,
  });
  const responses: string[] = [];
  conversation.on("event", (event: Event) => {
    if (event.kind === "MessageEvent" && event.llm_message?.role === "assistant") {
      const content = event.llm_message.content as TextContent[];
      const text = extractMessageText(content);
      if (text) responses.push(text);
    }
  });
  await conversation.sendUserMessage(prompt);
  return {
    reply: responses[responses.length - 1] ?? "",
    outbound_messages: outboundMessages.length ? outboundMessages : undefined,
  };
}

export function createConversationRuntime({
  env,
  persistenceRoot,
  persistenceDir,
}: ConversationRuntimeArgs) {
  const conversations = new Map<string, ConversationRecord>();
  const eventSubscribers = new Map<string, Set<EventSubscriber>>();
  let lastEventAt = Date.now();

  function touch(): void {
    lastEventAt = Date.now();
  }

  function resolveConversationToolProfile(
    request: StartConversationRequest,
    smolpawsConfig: SmolpawsConversationConfigValue | undefined,
    activeConversationIdRef: () => string | undefined,
  ): ConversationToolProfile {
    const requestedToolNames = normalizeRequestedToolNames(request.agent.tools);
    return {
      includeDefaultTools:
        requestedToolNames === undefined
          ? true
          : DEFAULT_REMOTE_TOOL_NAMES.filter((name) =>
              requestedToolNames.includes(name),
            ),
      tools: [
        ...buildRequestedNonDefaultTools(requestedToolNames ?? []),
        ...(shouldEnableSendMessage(smolpawsConfig)
          ? [createCurrentThreadMessageTool(async (message) => {
              const activeConversationId = activeConversationIdRef();
              if (!activeConversationId) {
                throw new Error("conversation_id_unavailable");
              }
              await appendOutboundMessage(
                activeConversationId,
                persistenceRoot,
                message,
              );
            })]
          : []),
        ...(shouldEnableTaskTools(smolpawsConfig)
          ? createTaskTools({
              getConfig: () => {
                const activeConversationId = activeConversationIdRef();
                if (activeConversationId) {
                  return conversations.get(activeConversationId)?.smolpaws ?? smolpawsConfig;
                }
                return smolpawsConfig;
              },
              onCommand: async (command: SmolpawsTaskCommand) => {
                const activeConversationId = activeConversationIdRef();
                if (!activeConversationId) {
                  throw new Error("conversation_id_unavailable");
                }
                await appendTaskCommand(
                  activeConversationId,
                  persistenceRoot,
                  command,
                );
              },
            })
          : []),
      ],
    };
  }

  function addEventSubscriber(
    conversationId: string,
    subscriber: EventSubscriber,
  ): () => void {
    let subscribers = eventSubscribers.get(conversationId);
    if (!subscribers) {
      subscribers = new Set<EventSubscriber>();
      eventSubscribers.set(conversationId, subscribers);
    }
    subscribers.add(subscriber);
    return () => {
      const current = eventSubscribers.get(conversationId);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (!current.size) {
        eventSubscribers.delete(conversationId);
      }
    };
  }

  function broadcastConversationEvent(conversationId: string, event: Event): void {
    const subscribers = eventSubscribers.get(conversationId);
    if (!subscribers?.size) {
      return;
    }
    for (const subscriber of Array.from(subscribers)) {
      subscriber(event);
    }
  }

  async function persistSmolpawsConfig(
    record: ConversationRecord,
  ): Promise<void> {
    if (!record.smolpaws) {
      return;
    }
    await writeConversationMeta(
      record.id,
      persistenceRoot,
      { title: record.title, smolpaws: record.smolpaws },
      record,
    );
  }

  async function refreshConversationSmolpawsConfig(
    record: ConversationRecord,
    requestedConfig: SmolpawsConversationConfigValue | undefined,
  ): Promise<void> {
    const merged = mergeSmolpawsConfig(record.smolpaws, requestedConfig);
    if (!merged) {
      return;
    }
    record.smolpaws = merged;
    await persistSmolpawsConfig(record);
  }

  async function createConversationRecord(
    request: StartConversationRequest,
  ): Promise<{ record: ConversationRecord; isNew: boolean }> {
    const requestedId = request.conversation_id?.trim();
    if (requestedId && !isSafeConversationId(requestedId)) {
      throw new Error("invalid_conversation_id");
    }
    if (requestedId) {
      const existing = conversations.get(requestedId);
      if (existing) {
        await refreshConversationSmolpawsConfig(existing, request.smolpaws);
        return { record: existing, isNew: false };
      }
    }
    const wasPersisted = requestedId
      ? hasPersistedConversation(requestedId, persistenceRoot)
      : false;
    const persistedMeta = requestedId && wasPersisted
      ? await readPersistedConversationMeta(requestedId, persistenceRoot)
      : {};
    const smolpawsConfig = request.smolpaws ?? persistedMeta.smolpaws;

    const registry = new SecretRegistry();
    const settings = buildSettingsFromRequest(request, registry, env);
    const workspaceRoot = resolveWorkspaceRoot(request.workspace?.working_dir, env);
    const workspace = Workspace({ kind: "local", root: workspaceRoot });
    const projectSkillsRoot = resolveProjectSkillsRoot({
      workspaceRoot,
      env,
      smolpawsConfig,
    });
    const agentContext = buildAgentContext(
      workspaceRoot,
      projectSkillsRoot,
      env,
      smolpawsConfig,
    );
    let activeConversationId = requestedId;
    const toolProfile = resolveConversationToolProfile(
      request,
      smolpawsConfig,
      () => activeConversationId,
    );
    const conversation = new LocalConversation({
      settings,
      workspace,
      secrets: registry,
      tools: toolProfile.tools,
      includeDefaultTools: toolProfile.includeDefaultTools,
      persistenceDir,
      agentContext,
    });

    const id = requestedId || (await conversation.startNewConversation());
    if (!id) {
      throw new Error("conversation_id_unavailable");
    }
    activeConversationId = id;

    if (requestedId) {
      conversation.restoreConversation(id);
    }

    const persistedInfo = requestedId && wasPersisted
      ? await buildConversationInfoFromPersistence(
          id,
          persistenceRoot,
          deriveExecutionStatusFromEvents,
        )
      : undefined;
    const record: ConversationRecord = {
      id,
      createdAt: persistedInfo?.created_at ?? new Date().toISOString(),
      updatedAt: persistedInfo?.updated_at ?? new Date().toISOString(),
      title: persistedInfo?.title,
      conversation,
      events: requestedId
        ? await readPersistedEventsOrThrow(id, persistenceRoot).catch((error) => {
            if (
              !wasPersisted &&
              error instanceof Error &&
              error.message === "conversation_not_found"
            ) {
              return [];
            }
            throw error;
          })
        : [],
      settings,
      secrets: registry,
      workspaceRoot,
      smolpaws: smolpawsConfig,
      toolProfile,
    };

    if (record.events.length) {
      const firstEvent = record.events[0];
      const lastEvent = record.events[record.events.length - 1];
      if (firstEvent?.timestamp) {
        record.createdAt = firstEvent.timestamp;
      }
      if (lastEvent?.timestamp) {
        record.updatedAt = lastEvent.timestamp;
      }
    }

    conversation.on("event", (event: Event) => {
      record.events.push(event);
      record.updatedAt = new Date().toISOString();
      touch();
      broadcastConversationEvent(id, event);
    });

    conversations.set(id, record);
    await persistSmolpawsConfig(record);
    return { record, isNew: !requestedId || !wasPersisted };
  }

  function getConversationOrThrow(id: string): ConversationRecord {
    const record = conversations.get(id);
    if (!record) {
      throw new Error("conversation_not_found");
    }
    return record;
  }

  async function applyConfirmationPolicy(
    record: ConversationRecord,
    request: SetConfirmationPolicyRequest,
  ): Promise<void> {
    const policy = request.policy;
    if (policy.kind === "AlwaysConfirm") {
      await record.conversation.setConfirmationPolicy(
        createConfirmationPolicyFromSettings({ policy: "always" }),
      );
      return;
    }
    if (policy.kind === "ConfirmRisky") {
      await record.conversation.setConfirmationPolicy(
        createConfirmationPolicyFromSettings({
          policy: "risky",
          riskyThreshold: policy.threshold,
          confirmUnknown: policy.confirm_unknown ?? true,
        }),
      );
      return;
    }
    await record.conversation.setConfirmationPolicy(
      createConfirmationPolicyFromSettings({ policy: "never" }),
    );
  }

  async function applySecurityAnalyzer(
    record: ConversationRecord,
    request: SetSecurityAnalyzerRequest,
  ): Promise<void> {
    if (request.security_analyzer?.kind === "LLMSecurityAnalyzer") {
      await record.conversation.setSecurityAnalyzer(new LLMSecurityAnalyzer());
      return;
    }
    await record.conversation.setSecurityAnalyzer(null);
  }

  async function deleteConversation(conversationId: string): Promise<boolean> {
    if (!isSafeConversationId(conversationId)) {
      throw new Error("invalid_conversation_id");
    }
    const record = conversations.get(conversationId);
    const persisted = hasPersistedConversation(conversationId, persistenceRoot);
    if (!record && !persisted) {
      return false;
    }
    if (record) {
      await record.conversation.pause().catch(() => undefined);
      conversations.delete(conversationId);
    }
    eventSubscribers.delete(conversationId);
    const conversationDir = buildConversationDirPath(
      conversationId,
      persistenceRoot,
      record,
    );
    await import("node:fs/promises").then(({ default: fs }) =>
      fs.rm(conversationDir, { recursive: true, force: true }),
    );
    return true;
  }

  async function updateConversationTitle(
    conversationId: string,
    title: string,
  ): Promise<boolean> {
    if (!isSafeConversationId(conversationId)) {
      throw new Error("invalid_conversation_id");
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error("invalid_conversation_title");
    }
    const record = conversations.get(conversationId);
    const persisted = hasPersistedConversation(conversationId, persistenceRoot);
    if (!record && !persisted) {
      return false;
    }
    let persistedMeta: { smolpaws?: SmolpawsConversationConfigValue } = {};
    if (!record && persisted) {
      try {
        persistedMeta = await readPersistedConversationMeta(
          conversationId,
          persistenceRoot,
        );
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const now = new Date().toISOString();
    if (record) {
      record.title = trimmedTitle;
      record.updatedAt = now;
    }

    await writeConversationMeta(
      conversationId,
      persistenceRoot,
      {
        title: trimmedTitle,
        smolpaws: record?.smolpaws ?? persistedMeta.smolpaws,
      },
      record,
    );
    return true;
  }

  async function runQueuedConversation(record: ConversationRecord): Promise<void> {
    await record.conversation.runPending();
  }

  return {
    conversations,
    persistenceRoot,
    getLastEventAt: () => lastEventAt,
    touch,
    registerSecrets,
    runStandaloneQuestion,
    createConversationRecord,
    getConversationOrThrow,
    addEventSubscriber,
    applyConfirmationPolicy,
    applySecurityAnalyzer,
    deleteConversation,
    updateConversationTitle,
    runQueuedConversation,
    hasQueuedUserMessage,
    resolvePersistenceRoot: () =>
      resolveAbsolutePersistenceRoot(resolvePersistenceDir(env), env),
    extractTextFromMessageRequest,
  };
}

export type ConversationRuntime = ReturnType<typeof createConversationRuntime>;
