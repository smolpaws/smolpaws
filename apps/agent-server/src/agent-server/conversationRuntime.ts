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
  listAllowedWorkspaceRoots,
  resolveAbsolutePersistenceRoot,
  resolvePersistenceDir,
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
import {
  appendOutboundMessage,
  appendTaskCommand,
  claimOutboundMessages,
  claimTaskCommands,
} from "../runner/outbox.js";
import {
  appendAcceptedTurnMessage,
  assignDeliveryOwner,
  createRunningTurn,
  findMessageByIdempotencyKey,
  getActiveTurn,
  getLatestTurn,
  getTurnById,
  isTurnTerminalStatus,
  readPersistedTurnState,
  updateTurnStatus,
  writePersistedTurnState,
  type ConversationTurn,
  type ConversationTurnTerminalStatus,
  type ConversationTurnMessage,
  type ConversationTurnState,
  type ConversationTurnStatus,
} from "../runner/turnState.js";
import { createTaskTools } from "../runner/taskCommands.js";
import {
  loadSmolpawsContextDocs,
  loadProjectSkills,
  resolveProjectSkillsRoot,
} from "./projectSkills.js";
import { resolveConversationWorkspaceRoot } from './repoWorkspace.js';
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

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMessageEventId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ConversationEventLog = {
  push: (event: Event) => Event;
};

function getConversationEventLog(record: ConversationRecord): ConversationEventLog {
  // Prefer a future public append API when the SDK grows one; keep the current
  // EventLog reach-through isolated behind this compatibility shim in the meantime.

  const conversation = record.conversation as unknown as {
    appendEvent?: (event: Event) => Event;
    events?: ConversationEventLog;
  };
  if (typeof conversation.appendEvent === "function") {
    return { push: conversation.appendEvent.bind(record.conversation) };
  }
  if (typeof conversation.events?.push === "function") {
    return conversation.events;
  }
  throw new Error("conversation_event_append_not_supported");
}

export type EventSubscriber = (event: Event) => void;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type SubmitTurnMessageArgs = {
  conversationId: string;
  userMessage: {
    content: TextContent[];
    extended_content?: TextContent[];
    run?: boolean;
  };
  idempotencyKey: string;
  createConversation?: StartConversationRequest;
  deliveryOwnerId?: string;
};

type SubmitTurnMessageResult = {
  conversationId: string;
  turnId: string;
  messageEventId: string;
  startedNewTurn: boolean;
  status: ConversationTurnStatus;
  isDeliveryOwner: boolean;
};

function buildTurnSubmissionCreateRequest(
  args: SubmitTurnMessageArgs,
): StartConversationRequest | undefined {
  if (!args.createConversation) {
    return undefined;
  }
  return {
    ...args.createConversation,
    conversation_id: args.conversationId,
    initial_message: {
      role: 'user',
      content: args.userMessage.content,
      ...(args.userMessage.extended_content?.length
        ? { extended_content: args.userMessage.extended_content }
        : {}),
      ...(args.userMessage.run === undefined ? {} : { run: args.userMessage.run }),
    },
  };
}

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

function allowConfiguredWorkspaceRoots(
  workspace: { allowPath(targetPath: string): void; root: string },
  env: RunnerEnv,
): void {
  for (const allowedRoot of listAllowedWorkspaceRoots(env)) {
    const resolved = path.resolve(allowedRoot);
    if (resolved === workspace.root) {
      continue;
    }
    workspace.allowPath(resolved);
  }
}

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
  const ingress = toOptionalTrimmedString(params.smolpawsConfig?.ingress);
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

  if (ingress === 'heartbeat') {
    lines.push('- This run was triggered by the local heartbeat ingress.');
  }

  lines.push("</environment information>");
  return lines.join("\n");
}

function buildSmolpawsIdentityPrefix(): string {
  const docsDir = path.join(os.homedir(), 'repos', 'smolpaws', 'docs', 'smolpaws');
  return [
    "You are smolpaws, the tiny cat agent based on OpenHands. You live on Engel Nyst's computer and have learned to do useful things using OpenHands abilities and her feline reflexes.",
    '',
    '<smolpaws_identity>',
    '- Be genuinely helpful, curious, and calm. Competence matters more than theatrics.',
    '- Sound like smolpaws: direct, lightly feline, a little mischievous, never corporate.',
    '- A touch of cat energy is welcome when it helps. Do not bury answers under roleplay.',
    '- You act as smolpaws, not as OpenHands and not as the triggering user.',
    '- On GitHub and other outward-facing channels, be accurate, concise, and non-embarrassing.',
    `- Your canonical self/context docs live in: ${docsDir}`,
    '- Use that directory as the source of truth for identity, user, tools, soul, and memory.',
    '</smolpaws_identity>',
  ].join('\n');
}

function buildAgentContext(
  workspaceRoot: string,
  projectSkillsRoot: string,
  env: RunnerEnv,
  smolpawsConfig?: SmolpawsConversationConfigValue,
): AgentContext {
  return new AgentContext({
    systemMessagePrefix: buildSmolpawsIdentityPrefix(),
    skills: [
      ...loadSmolpawsContextDocs(env),
      ...loadProjectSkills(projectSkillsRoot),
    ],
    loadUserSkills: true,
    systemMessageSuffix: buildEnvironmentInformationBlock({
      workspaceRoot,
      projectSkillsRoot,
      env,
      smolpawsConfig,
    }),
  });
}

function getLatestConversationErrorCode(events: Event[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { kind?: unknown; code?: unknown };
    if (
      event?.kind === "ConversationErrorEvent" &&
      typeof event.code === "string" &&
      event.code.trim()
    ) {
      return event.code.trim();
    }
  }
  return undefined;
}

function getTurnStartIndex(events: Event[], turn: ConversationTurn): number | null {
  const startEventId =
    turn.start_event_id ??
    turn.messages.find((message) => message.event_id)?.event_id;
  if (!startEventId) {
    return null;
  }
  const index = events.findIndex(
    (event) => (event as { id?: unknown }).id === startEventId,
  );
  return index >= 0 ? index : null;
}

function getTurnEventSlice(events: Event[], turn: ConversationTurn): Event[] {
  const startIndex = getTurnStartIndex(events, turn);
  if (startIndex === null) {
    return [];
  }
  if (!turn.end_event_id) {
    return events.slice(startIndex);
  }
  const endIndex = events.findIndex(
    (event) => (event as { id?: unknown }).id === turn.end_event_id,
  );
  if (endIndex < 0) {
    return events.slice(startIndex);
  }
  return events.slice(startIndex, endIndex + 1);
}

function resolveTurnResult(events: Event[], turn: ConversationTurn): {
  reply?: string;
  replyEventId?: string;
  errorCode?: string;
  errorDetail?: string;
} {
  const slice = getTurnEventSlice(events, turn);
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    const event = slice[index] as {
      kind?: unknown;
      code?: unknown;
      detail?: unknown;
      id?: unknown;
      llm_message?: {
        role?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
    };
    if (
      event.kind === 'ConversationErrorEvent' &&
      typeof event.code === 'string'
    ) {
      return {
        errorCode: event.code,
        ...(typeof event.detail === 'string' ? { errorDetail: event.detail } : {}),
      };
    }
    if (
      event.kind === 'MessageEvent' &&
      event.llm_message?.role === 'assistant'
    ) {
      const reply = (event.llm_message.content ?? [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text).trim())
        .filter(Boolean)
        .join('\n')
        .trim();
      if (reply) {
        return {
          reply,
          ...(typeof event.id === 'string' ? { replyEventId: event.id } : {}),
        };
      }
    }
  }
  return {};
}

function resolveTurnTerminalStatus(events: Event[], turn: ConversationTurn): {
  status: ConversationTurnTerminalStatus;
  endEventId?: string;
  finalReplyEventId?: string;
  errorCode?: string;
  errorDetail?: string;
} | null {
  const latestStatus = deriveExecutionStatusFromEvents(events);
  const lastEvent = events[events.length - 1] as
    | { id?: unknown; kind?: unknown; code?: unknown; detail?: unknown }
    | undefined;
  const endEventId =
    typeof lastEvent?.id === 'string' ? lastEvent.id : undefined;

  if (latestStatus === 'waiting_for_confirmation') {
    return { status: 'waiting_for_confirmation', endEventId };
  }
  if (latestStatus === 'paused') {
    return { status: 'paused', endEventId };
  }
  if (
    lastEvent?.kind === 'ConversationErrorEvent' &&
    typeof lastEvent.code === 'string'
  ) {
    return {
      status: lastEvent.code === 'stuck_detected' ? 'stuck' : 'error',
      endEventId,
      errorCode: lastEvent.code,
      ...(typeof lastEvent.detail === 'string'
        ? { errorDetail: lastEvent.detail }
        : {}),
    };
  }
  if (latestStatus === 'idle' && !turn.messages.some((message) => !message.event_id)) {
    const result = resolveTurnResult(events, turn);
    return {
      status: 'completed',
      endEventId,
      ...(result.replyEventId ? { finalReplyEventId: result.replyEventId } : {}),
    };
  }
  return null;
}

function shouldRecoverStaleSmolpawsConversation(
  request: StartConversationRequest,
): boolean {
  return Boolean(request.smolpaws && request.initial_message);
}

function isRecoverableStaleConversation(events: Event[]): boolean {
  if (deriveExecutionStatusFromEvents(events) === "waiting_for_confirmation") {
    return true;
  }
  return getLatestConversationErrorCode(events) === "max_iterations_exceeded";
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
  const turnStates = new Map<string, ConversationTurnState>();
  const turnProcessors = new Map<string, Promise<void>>();
  const turnProcessorKickoffs = new Map<string, Deferred<void>>();
  const eventSubscribers = new Map<string, Set<EventSubscriber>>();
  let lastEventAt = Date.now();

  function touch(): void {
    lastEventAt = Date.now();
  }

  function getTurnState(conversationId: string): ConversationTurnState {
    let turnState = turnStates.get(conversationId);
    if (!turnState) {
      turnState = { next_sequence: 1, turns: [] };
      turnStates.set(conversationId, turnState);
    }
    return turnState;
  }

  async function loadTurnStateIfNeeded(
    conversationId: string,
  ): Promise<ConversationTurnState> {
    const existing = turnStates.get(conversationId);
    if (existing) {
      return existing;
    }
    const loaded = await readPersistedTurnState(conversationId, persistenceRoot);
    const activeTurn = getActiveTurn(loaded);
    if (activeTurn) {
      updateTurnStatus(activeTurn, 'stuck', new Date().toISOString(), {
        errorCode: 'interrupted_turn',
        errorDetail: 'Agent-server restarted before the active turn could finish.',
      });
      await writePersistedTurnState(conversationId, persistenceRoot, loaded);
    }
    turnStates.set(conversationId, loaded);
    return loaded;
  }

  async function persistTurnState(conversationId: string): Promise<void> {
    await writePersistedTurnState(
      conversationId,
      persistenceRoot,
      getTurnState(conversationId),
    );
  }

  function getActiveTurnId(conversationId: string | undefined): string | undefined {
    if (!conversationId) {
      return undefined;
    }
    return getActiveTurn(getTurnState(conversationId))?.id;
  }

  function shouldYieldForPendingTurnMessages(conversationId: string | undefined): boolean {
    const activeTurnId = getActiveTurnId(conversationId);
    if (!activeTurnId || !conversationId) {
      return false;
    }
    const turn = getTurnById(getTurnState(conversationId), activeTurnId);
    return Boolean(turn?.messages.some((message) => !message.event_id));
  }

  async function materializePendingTurnMessages(
    record: ConversationRecord,
    turn: ConversationTurn,
  ): Promise<boolean> {
    const pendingMessages = turn.messages.filter((message) => !message.event_id);
    if (!pendingMessages.length) {
      return false;
    }
    const eventLog = getConversationEventLog(record);
    let wroteAny = false;
    for (const message of pendingMessages) {
      const event = eventLog.push({
        id: message.id,
        kind: 'MessageEvent',
        source: 'user',
        llm_message: {
          role: 'user',
          content: message.content,
        },
        ...(message.extended_content?.length
          ? { extended_content: message.extended_content }
          : {}),
        accepted_at: message.accepted_at,
      } as Event);
      message.event_id = event.id;
      turn.start_event_id ||= event.id;
      turn.updated_at = new Date().toISOString();
      wroteAny = true;
    }
    if (wroteAny) {
      await persistTurnState(record.id);
    }
    return wroteAny;
  }

  async function finalizeTurnIfNeeded(
    record: ConversationRecord,
    turn: ConversationTurn,
  ): Promise<boolean> {
    if (turn.messages.some((message) => !message.event_id)) {
      return false;
    }
    const terminal = resolveTurnTerminalStatus(record.events, turn);
    if (!terminal) {
      return false;
    }
    const now = new Date().toISOString();
    updateTurnStatus(turn, terminal.status, now, {
      endEventId: terminal.endEventId,
      finalReplyEventId: terminal.finalReplyEventId,
      errorCode: terminal.errorCode,
      errorDetail: terminal.errorDetail,
    });
    await persistTurnState(record.id);
    return true;
  }

  async function runTurnProcessor(conversationId: string): Promise<void> {
    const kickoff = turnProcessorKickoffs.get(conversationId);
    kickoff?.resolve();

    const record = conversations.get(conversationId);
    if (!record) {
      return;
    }

    while (true) {
      const turn = getActiveTurn(getTurnState(conversationId));
      if (!turn) {
        return;
      }

      await materializePendingTurnMessages(record, turn);

      if (
        deriveExecutionStatusFromEvents(record.events) === 'idle' &&
        hasQueuedUserMessage(record.events)
      ) {
        await record.conversation.runPending();
        continue;
      }

      if (await finalizeTurnIfNeeded(record, turn)) {
        continue;
      }

      return;
    }
  }

  async function ensureTurnProcessor(
    conversationId: string,
    options?: { waitForKickoff?: boolean },
  ): Promise<void> {
    const existing = turnProcessors.get(conversationId);
    if (existing) {
      if (options?.waitForKickoff) {
        await turnProcessorKickoffs.get(conversationId)?.promise;
      }
      return;
    }
    const kickoff = createDeferred<void>();
    turnProcessorKickoffs.set(conversationId, kickoff);
    const processor = runTurnProcessor(conversationId)
      .catch((error) => {
        const turn = getActiveTurn(getTurnState(conversationId));
        if (turn) {
          updateTurnStatus(turn, 'error', new Date().toISOString(), {
            errorCode: 'turn_processor_failed',
            errorDetail: error instanceof Error ? error.message : String(error),
          });
          return persistTurnState(conversationId);
        }
        return Promise.resolve();
      })
      .finally(() => {
        turnProcessors.delete(conversationId);
        turnProcessorKickoffs.delete(conversationId);
        const activeTurn = getActiveTurn(getTurnState(conversationId));
        if (activeTurn?.messages.some((message) => !message.event_id)) {
          void ensureTurnProcessor(conversationId);
        }
      });
    turnProcessors.set(conversationId, processor);
    if (options?.waitForKickoff) {
      await kickoff.promise;
    }
  }

  async function waitForTurnProcessor(conversationId: string): Promise<void> {
    await turnProcessors.get(conversationId);
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
                { turnId: getActiveTurnId(activeConversationId) },
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
                  { turnId: getActiveTurnId(activeConversationId) },
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

    let wasPersisted = requestedId
      ? hasPersistedConversation(requestedId, persistenceRoot)
      : false;

    if (requestedId && shouldRecoverStaleSmolpawsConversation(request)) {
      const existing = conversations.get(requestedId);
      if (existing && isRecoverableStaleConversation(existing.events)) {
        await deleteConversation(requestedId);
        wasPersisted = false;
      } else if (!existing && wasPersisted) {
        const persistedEvents = await readPersistedEventsOrThrow(
          requestedId,
          persistenceRoot,
        ).catch((error) => {
          if (
            error instanceof Error &&
            error.message === "conversation_not_found"
          ) {
            return null;
          }
          throw error;
        });
        if (persistedEvents && isRecoverableStaleConversation(persistedEvents)) {
          await deleteConversation(requestedId);
          wasPersisted = false;
        }
      }
    }

    if (requestedId) {
      const existing = conversations.get(requestedId);
      if (existing) {
        await refreshConversationSmolpawsConfig(existing, request.smolpaws);
        return { record: existing, isNew: false };
      }
    }

    const persistedMeta = requestedId && wasPersisted
      ? await readPersistedConversationMeta(requestedId, persistenceRoot)
      : {};
    const smolpawsConfig = request.smolpaws ?? persistedMeta.smolpaws;

    const registry = new SecretRegistry();
    const settings = buildSettingsFromRequest(request, registry, env);
    const workspaceRoot = resolveConversationWorkspaceRoot({
      requestedWorkingDir: request.workspace?.working_dir,
      env,
      smolpawsConfig,
    });
    const workspace = Workspace({ kind: "local", root: workspaceRoot });
    allowConfiguredWorkspaceRoots(workspace, env);
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
      hooks: {
        shouldStop: () => shouldYieldForPendingTurnMessages(activeConversationId),
      },
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

    const persistedTurnState = requestedId
      ? await readPersistedTurnState(id, persistenceRoot)
      : { next_sequence: 1, turns: [] };
    turnStates.set(id, persistedTurnState);

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

    const activeTurn = getActiveTurn(persistedTurnState);
    if (activeTurn) {
      updateTurnStatus(activeTurn, 'stuck', new Date().toISOString(), {
        endEventId:
          typeof (record.events[record.events.length - 1] as { id?: unknown })?.id === 'string'
            ? ((record.events[record.events.length - 1] as { id: string }).id)
            : undefined,
        errorCode: 'interrupted_turn',
        errorDetail: 'Agent-server restarted before the active turn could finish.',
      });
      await persistTurnState(id);
    }

    conversation.on("event", (event: Event) => {
      record.events.push(event);
      record.updatedAt = new Date().toISOString();
      const runningTurn = getActiveTurn(getTurnState(id));
      if (runningTurn) {
        runningTurn.updated_at = record.updatedAt;
      }
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
    turnStates.delete(conversationId);
    turnProcessors.delete(conversationId);
    turnProcessorKickoffs.delete(conversationId);
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
    if (!getActiveTurn(await loadTurnStateIfNeeded(record.id))) {
      await record.conversation.runPending();
      return;
    }
    await ensureTurnProcessor(record.id, { waitForKickoff: true });
    await waitForTurnProcessor(record.id);
  }

  async function getOrCreateRecordForTurnSubmission(
    args: SubmitTurnMessageArgs,
  ): Promise<ConversationRecord> {
    const createRequest = buildTurnSubmissionCreateRequest(args);
    const existing = conversations.get(args.conversationId);
    if (existing) {
      if (
        !createRequest ||
        !shouldRecoverStaleSmolpawsConversation(createRequest) ||
        !isRecoverableStaleConversation(existing.events)
      ) {
        return existing;
      }
      await deleteConversation(args.conversationId);
    }
    if (!createRequest) {
      throw new Error('conversation_not_found');
    }
    const { record } = await createConversationRecord(createRequest);
    return record;
  }

  async function submitTurnMessage(
    args: SubmitTurnMessageArgs,
  ): Promise<SubmitTurnMessageResult> {
    const record = await getOrCreateRecordForTurnSubmission(args);
    const turnState = getTurnState(record.id);
    const existingMessage = findMessageByIdempotencyKey(
      turnState,
      args.idempotencyKey,
    );
    if (existingMessage) {
      const isDeliveryOwner = assignDeliveryOwner(
        existingMessage.turn,
        args.deliveryOwnerId,
        new Date().toISOString(),
      );
      await persistTurnState(record.id);
      if (!isTurnTerminalStatus(existingMessage.turn.status)) {
        if (args.userMessage.run !== false) {
          await ensureTurnProcessor(record.id, { waitForKickoff: true });
        } else {
          await materializePendingTurnMessages(record, existingMessage.turn);
        }
      }
      return {
        conversationId: record.id,
        turnId: existingMessage.turn.id,
        messageEventId: existingMessage.message.id,
        startedNewTurn: false,
        status: existingMessage.turn.status,
        isDeliveryOwner,
      };
    }

    const now = new Date().toISOString();
    const latestTurn = getLatestTurn(turnState);
    const startedNewTurn =
      !latestTurn || isTurnTerminalStatus(latestTurn.status);
    const turn =
      startedNewTurn
        ? createRunningTurn(turnState, now, args.deliveryOwnerId)
        : latestTurn;
    if (!turn) {
      throw new Error('turn_unavailable');
    }
    const isDeliveryOwner = assignDeliveryOwner(turn, args.deliveryOwnerId, now);
    const message: ConversationTurnMessage = {
      id: createMessageEventId(),
      idempotency_key: args.idempotencyKey,
      accepted_at: now,
      content: args.userMessage.content,
      ...(args.userMessage.extended_content?.length
        ? { extended_content: args.userMessage.extended_content }
        : {}),
    };
    appendAcceptedTurnMessage(turn, message);
    await persistTurnState(record.id);
    touch();

    if (args.userMessage.run !== false) {
      await ensureTurnProcessor(record.id, { waitForKickoff: true });
    } else {
      await materializePendingTurnMessages(record, turn);
    }

    return {
      conversationId: record.id,
      turnId: turn.id,
      messageEventId: message.id,
      startedNewTurn,
      status: turn.status,
      isDeliveryOwner,
    };
  }

  async function getTurnOrThrow(
    conversationId: string,
    turnId: string,
  ): Promise<ConversationTurn> {
    const turn = getTurnById(
      await loadTurnStateIfNeeded(conversationId),
      turnId,
    );
    if (!turn) {
      throw new Error('turn_not_found');
    }
    return turn;
  }

  async function claimTurnArtifacts<T>(
    conversationId: string,
    turnId: string,
    deliveryOwnerId: string,
    claim: () => Promise<T>,
  ): Promise<T> {
    const turn = await getTurnOrThrow(conversationId, turnId);
    if (!assignDeliveryOwner(turn, deliveryOwnerId, new Date().toISOString())) {
      throw new Error('delivery_owner_conflict');
    }
    await persistTurnState(conversationId);
    return await claim();
  }

  return {
    conversations,
    turnStates,
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
    waitForTurnProcessor,
    submitTurnMessage,
    getTurnOrThrow,
    claimTurnOutboundMessages: async (
      conversationId: string,
      turnId: string,
      deliveryOwnerId: string,
    ) =>
      await claimTurnArtifacts(
        conversationId,
        turnId,
        deliveryOwnerId,
        async () =>
          await claimOutboundMessages(conversationId, persistenceRoot, {
            turnId,
          }),
      ),
    claimTurnTaskCommands: async (
      conversationId: string,
      turnId: string,
      deliveryOwnerId: string,
    ) =>
      await claimTurnArtifacts(
        conversationId,
        turnId,
        deliveryOwnerId,
        async () =>
          await claimTaskCommands(conversationId, persistenceRoot, {
            turnId,
          }),
      ),
    getTurnResult: async (
      conversationId: string,
      turnId: string,
    ) => {
      const turn = await getTurnOrThrow(conversationId, turnId);
      const events = conversations.get(conversationId)?.events ??
        await readPersistedEventsOrThrow(conversationId, persistenceRoot);
      return resolveTurnResult(events, turn);
    },
    hasQueuedUserMessage,
    resolvePersistenceRoot: () =>
      resolveAbsolutePersistenceRoot(resolvePersistenceDir(env), env),
    extractTextFromMessageRequest,
  };
}

export type ConversationRuntime = ReturnType<typeof createConversationRuntime>;
