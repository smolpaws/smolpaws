import {
  LLMSecurityAnalyzer,
  LocalConversation,
  SecretRegistry,
  Workspace,
  createConfirmationPolicyFromSettings,
  type Event,
  type OpenHandsSettings,
  type TextContent,
} from "@smolpaws/agent-sdk";
import { randomUUID } from "crypto";
import type { DaytonaLlmConfig } from "../daytona.js";
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
import type {
  SmolpawsConversationConfigValue,
  SmolpawsRunnerResponse,
  SmolpawsTaskCommand,
} from "../shared/runner.js";
import type {
  SetConfirmationPolicyRequest,
  SetSecurityAnalyzerRequest,
  SetSecretsRequest,
  StartConversationRequest,
} from "./models.js";

const DEFAULT_MODEL_ENV = "LLM_MODEL";
const DEFAULT_API_KEY_ENV = "LLM_API_KEY";

export type EventSubscriber = (event: Event) => void;

type ConversationRuntimeArgs = {
  env: RunnerEnv;
  persistenceRoot: string;
  persistenceDir?: string;
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
  };
}

export function buildSettingsFromEnv(env: RunnerEnv): OpenHandsSettings {
  const model = env.LLM_MODEL ?? process.env[DEFAULT_MODEL_ENV];
  if (!model) {
    throw new Error(
      `LLM model is required. Set ${DEFAULT_MODEL_ENV} or LLM_MODEL.`,
    );
  }

  return {
    llm: {
      provider: env.LLM_PROVIDER as OpenHandsSettings["llm"]["provider"],
      model,
      baseUrl: env.LLM_BASE_URL,
    },
    agent: {
      enableSecurityAnalyzer: false,
      debug: false,
      summarizeToolCalls: false,
    },
    conversation: {
      maxIterations: 50,
      stuckDetection: true,
    },
    confirmation: {
      policy: "never",
      riskyThreshold: "HIGH",
      confirmUnknown: true,
    },
    secrets: {
      llmApiKey: env.LLM_API_KEY ?? process.env[DEFAULT_API_KEY_ENV],
    },
  };
}

export function buildLlmConfigFromEnv(env: RunnerEnv): DaytonaLlmConfig {
  const model = env.LLM_MODEL ?? process.env[DEFAULT_MODEL_ENV];
  if (!model) {
    throw new Error(
      `LLM model is required. Set ${DEFAULT_MODEL_ENV} or LLM_MODEL.`,
    );
  }
  return {
    model,
    provider: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY ?? process.env[DEFAULT_API_KEY_ENV],
  };
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

function buildSettingsFromRequest(
  request: StartConversationRequest,
  registry: SecretRegistry,
): OpenHandsSettings {
  const llm = request.agent.llm;
  const model = typeof llm.model === "string" ? llm.model.trim() : "";
  if (!model) {
    throw new Error("LLM model is required");
  }
  const settings: OpenHandsSettings = {
    llm: {
      provider:
        typeof llm.provider === "string"
          ? (llm.provider as OpenHandsSettings["llm"]["provider"])
          : undefined,
      model,
      baseUrl: typeof llm.base_url === "string" ? llm.base_url : undefined,
      apiVersion: typeof llm.api_version === "string" ? llm.api_version : undefined,
      timeout: typeof llm.timeout === "number" ? llm.timeout : undefined,
      temperature: typeof llm.temperature === "number" ? llm.temperature : undefined,
      topP: typeof llm.top_p === "number" ? llm.top_p : undefined,
      topK: typeof llm.top_k === "number" ? llm.top_k : undefined,
      maxInputTokens:
        typeof llm.max_input_tokens === "number"
          ? llm.max_input_tokens
          : undefined,
      maxOutputTokens:
        typeof llm.max_output_tokens === "number"
          ? llm.max_output_tokens
          : undefined,
      reasoningEffort:
        typeof llm.reasoning_effort === "string"
          ? (llm.reasoning_effort as OpenHandsSettings["llm"]["reasoningEffort"])
          : undefined,
      reasoningSummary:
        typeof llm.reasoning_summary === "string"
          ? (llm.reasoning_summary as OpenHandsSettings["llm"]["reasoningSummary"])
          : undefined,
    },
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
      llmApiKey:
        typeof llm.api_key === "string" ? llm.api_key : undefined,
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

  return settings;
}

export async function runStandaloneQuestion(
  settings: OpenHandsSettings,
  prompt: string,
  workspaceRoot?: string,
  persistenceDir?: string,
  options?: { enableOutboundMessages?: boolean },
): Promise<SmolpawsRunnerResponse> {
  const registry = new SecretRegistry();
  const outboundMessages: RunnerOutboundMessage[] = [];
  const conversation = new LocalConversation({
    settings,
    workspace: Workspace({ kind: "local", root: workspaceRoot }),
    secrets: registry,
    tools: options?.enableOutboundMessages
      ? [createCurrentThreadMessageTool((message) => {
          outboundMessages.push(message);
        })]
      : [],
    includeDefaultTools: false,
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
    const settings = buildSettingsFromRequest(request, registry);
    const workspaceRoot = resolveWorkspaceRoot(request.workspace?.working_dir, env);
    const workspace = Workspace({ kind: "local", root: workspaceRoot });
    let activeConversationId = requestedId;
    let currentSmolpawsConfig = smolpawsConfig;
    const tools = [
      ...(shouldEnableSendMessage(currentSmolpawsConfig)
        ? [createCurrentThreadMessageTool(async (message) => {
            if (!activeConversationId) {
              throw new Error("conversation_id_unavailable");
            }
            await appendOutboundMessage(activeConversationId, persistenceRoot, message);
          })]
        : []),
      ...(shouldEnableTaskTools(currentSmolpawsConfig)
        ? createTaskTools({
            getConfig: () => {
              if (activeConversationId) {
                return conversations.get(activeConversationId)?.smolpaws ?? currentSmolpawsConfig;
              }
              return currentSmolpawsConfig;
            },
            onCommand: async (command: SmolpawsTaskCommand) => {
              if (!activeConversationId) {
                throw new Error("conversation_id_unavailable");
              }
              await appendTaskCommand(activeConversationId, persistenceRoot, command);
            },
          })
        : []),
    ];
    const conversation = new LocalConversation({
      settings,
      workspace,
      secrets: registry,
      tools,
      includeDefaultTools: true,
      persistenceDir,
    });

    const id = requestedId || (await conversation.startNewConversation());
    if (!id) {
      throw new Error("conversation_id_unavailable");
    }
    activeConversationId = id;
    currentSmolpawsConfig = smolpawsConfig;

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
    buildSettingsFromEnv: () => buildSettingsFromEnv(env),
    buildLlmConfigFromEnv: () => buildLlmConfigFromEnv(env),
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
