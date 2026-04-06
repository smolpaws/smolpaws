import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  isMessageEvent,
  reduceTextContent,
  type Event,
} from "@smolpaws/agent-sdk";
import {
  listConversationInfos,
  readPersistedConversationMeta,
  type ConversationInfo,
  type ConversationRecord,
} from "../runner/conversationService.js";
import { deriveExecutionStatusFromEvents } from "../runner/conversationState.js";
import { readPersistedEventsOrThrow } from "../runner/eventService.js";
import { extractExtendedContentText } from "../runner/messageText.js";
import {
  getLatestTurn,
  readPersistedTurnState,
  type ConversationTurn,
  type ConversationTurnState,
} from "../runner/turnState.js";
import { isAuthorized } from "../runner/workspacePolicy.js";
import type {
  SmolpawsConversationConfigValue,
  SmolpawsOutboundMessage,
  SmolpawsTaskCommand,
} from "../shared/runner.js";
import type { AgentServerDeps } from "./dependencies.js";
import { ErrorSchema } from "./models.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ACTIVITY_CACHE_TTL_MS = 1_500;
const ACTIVITY_INFOS_CACHE_TTL_MS = 5_000;

const ActivityTurnSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Number(),
  status: Type.String(),
  started_at: Type.String(),
  updated_at: Type.String(),
  completed_at: Type.Optional(Type.String()),
  error_code: Type.Optional(Type.String()),
  error_detail: Type.Optional(Type.String()),
});

const ActivityItemSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  updated_at: Type.String(),
  execution_status: Type.String(),
  is_live: Type.Boolean(),
  ingress: Type.String(),
  target: Type.String(),
  scope_id: Type.Optional(Type.String()),
  latest_event_kind: Type.Optional(Type.String()),
  latest_event_at: Type.Optional(Type.String()),
  latest_action: Type.Optional(Type.String()),
  last_user_message: Type.Optional(Type.String()),
  last_assistant_message: Type.Optional(Type.String()),
  pending_outbound_count: Type.Number(),
  pending_task_command_count: Type.Number(),
  latest_error: Type.Optional(Type.String()),
  latest_turn: Type.Optional(ActivityTurnSchema),
});

const ActivitySummarySchema = Type.Object({
  total_conversations: Type.Number(),
  running_count: Type.Number(),
  waiting_count: Type.Number(),
  error_count: Type.Number(),
  stuck_count: Type.Number(),
  pending_outbound_count: Type.Number(),
});

const ActivityResponseSchema = Type.Object({
  server_time: Type.String(),
  uptime_seconds: Type.Number(),
  idle_seconds: Type.Number(),
  items: Type.Array(ActivityItemSchema),
  summary: ActivitySummarySchema,
});

type ActivityTurn = Static<typeof ActivityTurnSchema>;
type ActivityItem = Static<typeof ActivityItemSchema>;
type ActivityResponse = Static<typeof ActivityResponseSchema>;

type QueueEnvelope<T> = {
  turn_id?: string;
  payload: T;
};

type ActivityCacheEntry = {
  limit: number;
  last_event_at: number;
  generated_at: number;
  response: ActivityResponse;
};

type ActivityInfosCacheEntry = {
  generated_at: number;
  items: ConversationInfo[];
};

type ActivitySummaryAccumulator = {
  total_conversations: number;
  running_count: number;
  waiting_count: number;
  error_count: number;
  stuck_count: number;
  pending_outbound_count: number;
};

type VisibleActivityCandidate = {
  info: ConversationInfo;
  updatedAt: string;
  preloaded: {
    record?: ConversationRecord;
    events: Event[];
    config: SmolpawsConversationConfigValue;
    turnState: ConversationTurnState;
    pendingOutbound: SmolpawsOutboundMessage[];
  };
};

function parseLimit(value: unknown): number {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(raw)));
}

function truncate(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function parseIsoTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function resolveUpdatedAt(...values: Array<string | undefined>): string | undefined {
  let latest = "";
  let latestTimestamp = 0;
  for (const value of values) {
    const timestamp = parseIsoTimestamp(value);
    if (timestamp > latestTimestamp && value) {
      latest = value;
      latestTimestamp = timestamp;
    }
  }
  return latest || undefined;
}

function extractMessageText(event: Event): string {
  if (!isMessageEvent(event)) {
    return "";
  }
  const parts = [reduceTextContent(event.llm_message).trim()];
  const extended = extractExtendedContentText(
    (event as { extended_content?: unknown }).extended_content,
  );
  if (extended) {
    parts.push(extended.trim());
  }
  const reasoning = (event as { reasoning_content?: unknown }).reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) {
    parts.push(reasoning.trim());
  }
  return parts
    .map((part) => unwrapPromptEnvelopeText(part))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function unwrapPromptEnvelopeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("<messages")) {
    return trimmed;
  }

  const matches = Array.from(
    trimmed.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g),
  );
  if (!matches.length) {
    return trimmed;
  }

  return matches
    .map((match) => decodeXmlEntities((match[1] ?? "").trim()))
    .filter(Boolean)
    .join("\n");
}

function compareIsoTimestampsDesc(left: string, right: string): number {
  return parseIsoTimestamp(right) - parseIsoTimestamp(left);
}

function getLatestMessageText(
  events: Event[],
  role: "user" | "assistant",
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isMessageEvent(event) || event.llm_message.role !== role) {
      continue;
    }
    const text = extractMessageText(event);
    if (text) {
      return truncate(text);
    }
  }
  return undefined;
}

function getLatestEventTimestamp(events: Event[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = (events[index] as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "string" && timestamp.trim()) {
      return timestamp;
    }
  }
  return undefined;
}

function getLatestActionLabel(events: Event[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as {
      kind?: unknown;
      tool_name?: unknown;
      action?: Record<string, unknown>;
    };
    if (event.kind !== "ActionEvent" || typeof event.tool_name !== "string") {
      continue;
    }
    const action = event.action ?? {};
    const detail =
      typeof action.command === "string" && action.command.trim()
        ? action.command
        : typeof action.path === "string" && action.path.trim()
          ? `${String(action.command ?? "file")}: ${action.path}`
          : typeof action.id === "string" && action.id.trim()
            ? action.id
            : "";
    return truncate(detail ? `${event.tool_name}: ${detail}` : event.tool_name);
  }
  return undefined;
}

function getLatestObservationError(events: Event[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as {
      kind?: unknown;
      tool_name?: unknown;
      observation?: {
        exit_code?: unknown;
        stderr?: unknown;
        error?: unknown;
      };
    };
    if (event.kind !== "ObservationEvent" || !event.observation) {
      continue;
    }
    const exitCode = event.observation.exit_code;
    const errorText =
      typeof event.observation.stderr === "string" && event.observation.stderr.trim()
        ? event.observation.stderr.trim()
        : typeof event.observation.error === "string" && event.observation.error.trim()
          ? event.observation.error.trim()
          : "";
    if (typeof exitCode === "number" && exitCode !== 0) {
      const prefix = typeof event.tool_name === "string" ? `${event.tool_name}: ` : "";
      return truncate(`${prefix}${errorText || `exit ${exitCode}`}`);
    }
    if (errorText) {
      const prefix = typeof event.tool_name === "string" ? `${event.tool_name}: ` : "";
      return truncate(`${prefix}${errorText}`);
    }
  }
  return undefined;
}

function formatEventKind(kind: string): string {
  return kind
    .replace(/Event$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
}

function getLatestEventKind(events: Event[]): string | undefined {
  let fallback: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { kind?: unknown } | undefined;
    if (typeof event?.kind !== "string") {
      continue;
    }
    if (!fallback) {
      fallback = event.kind;
    }
    if (event.kind === "ConversationStateUpdateEvent") {
      continue;
    }
    return formatEventKind(event.kind);
  }
  return fallback ? formatEventKind(fallback) : undefined;
}

function buildTargetLabel(
  conversationId: string,
  config?: SmolpawsConversationConfigValue,
): string {
  const github = config?.github;
  if (github?.repository_full_name) {
    if (typeof github.pull_request_number === "number") {
      return `${github.repository_full_name} PR #${github.pull_request_number}`;
    }
    if (typeof github.issue_number === "number") {
      return `${github.repository_full_name}#${github.issue_number}`;
    }
    return github.repository_full_name;
  }
  if (config?.scope_id?.trim()) {
    return config.scope_id.trim();
  }
  return conversationId;
}

function toActivityTurn(
  turn: ConversationTurn | undefined,
  options?: { isLive?: boolean },
): ActivityTurn | undefined {
  if (!turn) {
    return undefined;
  }
  const displayStatus =
    turn.status === "running" && options?.isLive === false
      ? "stuck"
      : turn.status;
  return {
    id: turn.id,
    sequence: turn.sequence,
    status: displayStatus,
    started_at: turn.started_at,
    updated_at: turn.updated_at,
    ...(turn.completed_at ? { completed_at: turn.completed_at } : {}),
    ...(turn.error_code ? { error_code: turn.error_code } : {}),
    ...(turn.error_detail ? { error_detail: turn.error_detail } : {}),
  };
}

function resolveExecutionStatus(options: {
  infoStatus: string;
  latestTurn?: ConversationTurn;
  isLive: boolean;
}): string {
  const latestTurn = options.latestTurn;
  if (!latestTurn) {
    return options.infoStatus;
  }
  if (latestTurn.status === "running") {
    return options.isLive ? "running" : "stuck";
  }
  return latestTurn.status;
}

async function readQueueItems<T>(
  conversationId: string,
  persistenceRoot: string,
  basename: string,
): Promise<T[]> {
  const filePath = path.join(persistenceRoot, conversationId, basename);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const items: T[] = [];
    for (const line of raw.split("\n")) {
      const normalized = line.trim();
      if (!normalized) {
        continue;
      }
      try {
        const item = JSON.parse(normalized) as QueueEnvelope<T> | T;
        items.push(
          item && typeof item === "object" && "payload" in item
            ? (item as QueueEnvelope<T>).payload
            : (item as T),
        );
      } catch {
        continue;
      }
    }
    return items;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadConversationEvents(
  info: ConversationInfo,
  record: ConversationRecord | undefined,
  persistenceRoot: string,
): Promise<Event[]> {
  if (record) {
    return record.events;
  }
  return await readPersistedEventsOrThrow(info.id, persistenceRoot).catch((error) => {
    if (error instanceof Error && error.message === "conversation_not_found") {
      return [];
    }
    throw error;
  });
}

async function loadConversationMeta(
  info: ConversationInfo,
  record: ConversationRecord | undefined,
  persistenceRoot: string,
): Promise<SmolpawsConversationConfigValue | undefined> {
  if (record?.smolpaws) {
    return record.smolpaws;
  }
  try {
    return (await readPersistedConversationMeta(info.id, persistenceRoot)).smolpaws;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function loadConversationTurnState(
  info: ConversationInfo,
  deps: AgentServerDeps,
): Promise<ConversationTurnState> {
  const live = deps.conversationRuntime.turnStates.get(info.id);
  if (live) {
    return live;
  }
  return await readPersistedTurnState(info.id, deps.persistenceRoot);
}

async function buildActivityItem(
  info: ConversationInfo,
  deps: AgentServerDeps,
  preloaded?: {
    record?: ConversationRecord;
    events?: Event[];
    config?: SmolpawsConversationConfigValue;
    turnState?: ConversationTurnState;
    pendingOutbound?: SmolpawsOutboundMessage[];
    pendingTasks?: SmolpawsTaskCommand[];
  },
): Promise<ActivityItem> {
  const record = preloaded?.record ?? deps.conversationRuntime.conversations.get(info.id);
  const isLive = Boolean(record);
  const [events, config, turnState, pendingOutbound, pendingTasks] =
    await Promise.all([
      preloaded?.events
        ? Promise.resolve(preloaded.events)
        : loadConversationEvents(info, record, deps.persistenceRoot),
      preloaded?.config
        ? Promise.resolve(preloaded.config)
        : loadConversationMeta(info, record, deps.persistenceRoot),
      preloaded?.turnState
        ? Promise.resolve(preloaded.turnState)
        : loadConversationTurnState(info, deps),
      preloaded?.pendingOutbound
        ? Promise.resolve(preloaded.pendingOutbound)
        : readQueueItems<SmolpawsOutboundMessage>(info.id, deps.persistenceRoot, "outbox.jsonl"),
      preloaded?.pendingTasks
        ? Promise.resolve(preloaded.pendingTasks)
        : readQueueItems<SmolpawsTaskCommand>(info.id, deps.persistenceRoot, "task-commands.jsonl"),
    ]);

  const latestTurn = getLatestTurn(turnState);
  const executionStatus = resolveExecutionStatus({
    infoStatus: events.length
      ? deriveExecutionStatusFromEvents(events)
      : info.execution_status,
    latestTurn,
    isLive,
  });
  const latestError =
    latestTurn?.error_detail ??
    latestTurn?.error_code ??
    getLatestObservationError(events);
  const latestEventAt = getLatestEventTimestamp(events);
  const latestEventKind = getLatestEventKind(events);
  const latestAction = getLatestActionLabel(events);
  const lastUserMessage = getLatestMessageText(events, "user");
  const lastAssistantMessage = getLatestMessageText(events, "assistant");
  const updatedAt = resolveUpdatedAt(
    latestEventAt,
    latestTurn?.updated_at,
  ) ?? info.updated_at;

  return {
    id: info.id,
    ...(info.title ? { title: info.title } : {}),
    updated_at: updatedAt,
    execution_status: executionStatus,
    is_live: isLive,
    ingress: config?.ingress?.trim() || "unknown",
    target: buildTargetLabel(info.id, config),
    ...(config?.scope_id?.trim() ? { scope_id: config.scope_id.trim() } : {}),
    ...(latestEventKind ? { latest_event_kind: latestEventKind } : {}),
    ...(latestEventAt ? { latest_event_at: latestEventAt } : {}),
    ...(latestAction ? { latest_action: latestAction } : {}),
    ...(lastUserMessage ? { last_user_message: lastUserMessage } : {}),
    ...(lastAssistantMessage ? { last_assistant_message: lastAssistantMessage } : {}),
    pending_outbound_count: pendingOutbound.length,
    pending_task_command_count: pendingTasks.length,
    ...(latestError ? { latest_error: truncate(latestError) } : {}),
    ...(latestTurn ? { latest_turn: toActivityTurn(latestTurn, { isLive }) } : {}),
  };
}

function createEmptySummary(): ActivitySummaryAccumulator {
  return {
    total_conversations: 0,
    running_count: 0,
    waiting_count: 0,
    error_count: 0,
    stuck_count: 0,
    pending_outbound_count: 0,
  };
}

function addSummaryItem(
  summary: ActivitySummaryAccumulator,
  status: string,
  hasPendingOutbound: boolean,
): void {
  summary.total_conversations += 1;
  if (status === "running") {
    summary.running_count += 1;
  } else if (status === "waiting_for_confirmation") {
    summary.waiting_count += 1;
  } else if (status === "error") {
    summary.error_count += 1;
  } else if (status === "stuck") {
    summary.stuck_count += 1;
  }
  if (hasPendingOutbound) {
    summary.pending_outbound_count += 1;
  }
}

function isTrackedSmolpawsConfig(
  config: SmolpawsConversationConfigValue | undefined,
): config is SmolpawsConversationConfigValue {
  return Boolean(config?.ingress?.trim());
}

function getIngressGroupKey(ingress: string): string {
  const normalized = ingress.trim().toLowerCase();
  if (normalized.startsWith("github")) {
    return "github";
  }
  if (normalized.startsWith("whatsapp")) {
    return "whatsapp";
  }
  if (normalized.startsWith("heartbeat")) {
    return "heartbeat";
  }
  return normalized || "other";
}

function limitItemsPerIngress(
  items: ActivityItem[],
  limit: number,
) : ActivityItem[] {
  const groups = new Map<string, ActivityItem[]>();

  for (const item of items) {
    const groupKey = getIngressGroupKey(item.ingress);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(groupKey, [item]);
    }
  }

  return Array.from(groups.values())
    .flatMap((items) =>
      items
        .sort((left, right) => compareIsoTimestampsDesc(left.updated_at, right.updated_at))
        .slice(0, limit),
    )
    .sort((left, right) => compareIsoTimestampsDesc(left.updated_at, right.updated_at));
}

function renderActivityPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SmolPaws Activity</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --panel: #111827;
        --panel-2: #1f2937;
        --text: #e5e7eb;
        --muted: #94a3b8;
        --accent: #22c55e;
        --warn: #f59e0b;
        --error: #f97316;
        --idle: #64748b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "SF Mono", "Monaco", "Cascadia Code", monospace;
        background:
          radial-gradient(circle at top left, rgba(34, 197, 94, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(14, 165, 233, 0.16), transparent 24%),
          linear-gradient(180deg, #020617 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      h1 {
        margin: 0 0 6px;
        font-size: 28px;
      }
      .subtle {
        color: var(--muted);
        margin: 0;
      }
      .toolbar,
      .auth,
      .summary,
      .section {
        border: 1px solid rgba(148, 163, 184, 0.22);
        background: rgba(17, 24, 39, 0.84);
        backdrop-filter: blur(6px);
        border-radius: 16px;
      }
      .toolbar,
      .auth {
        padding: 14px 16px;
        margin-top: 18px;
      }
      .toolbar {
        display: flex;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .toolbar label,
      .auth label {
        color: var(--muted);
        font-size: 13px;
      }
      .toolbar input,
      .auth input {
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: rgba(15, 23, 42, 0.8);
        color: var(--text);
        padding: 10px 12px;
        min-width: 96px;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        background: var(--accent);
        color: #04130a;
        font: inherit;
        cursor: pointer;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        padding: 14px;
        margin-top: 18px;
      }
      .metric {
        padding: 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
      }
      .metric .label {
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }
      .metric .value {
        font-size: 24px;
      }
      #cards {
        display: grid;
        gap: 18px;
        margin-top: 18px;
      }
      .section {
        padding: 16px;
      }
      .section-header {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 14px;
      }
      .section h2 {
        margin: 0;
        font-size: 16px;
      }
      .section-count {
        color: var(--muted);
        font-size: 13px;
      }
      .chip {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }
      .status-running { color: var(--accent); border-color: rgba(34, 197, 94, 0.45); }
      .status-waiting_for_confirmation { color: var(--warn); border-color: rgba(245, 158, 11, 0.45); }
      .status-error, .status-stuck { color: var(--error); border-color: rgba(249, 115, 22, 0.45); }
      .status-idle, .status-completed, .status-paused { color: var(--idle); border-color: rgba(100, 116, 139, 0.45); }
      .row-list {
        display: grid;
        gap: 12px;
      }
      .row {
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        user-select: text;
      }
      .row-top {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .row-title {
        font-size: 18px;
        font-weight: 700;
        margin: 0;
      }
      .row-meta {
        color: var(--muted);
        font-size: 12px;
        margin-top: 4px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .row-snippet {
        margin-top: 10px;
        display: grid;
        grid-template-columns: minmax(132px, 168px) minmax(0, 1fr);
        gap: 8px 14px;
        align-items: start;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .row-snippet .label {
        color: var(--muted);
        display: block;
        min-width: 0;
      }
      .row-foot {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .mini {
        color: var(--muted);
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
      }
      .row-detail {
        margin-top: 10px;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .detail {
        padding: 12px 14px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.025);
      }
      .detail .label {
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 4px;
      }
      .detail .value {
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      @media (max-width: 860px) {
        .row-top {
          flex-direction: column;
        }
        .row-snippet {
          grid-template-columns: 1fr;
          gap: 4px;
        }
      }
      #error {
        color: #fca5a5;
        margin-top: 14px;
      }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>SmolPaws Activity</h1>
      <p class="subtle">Live operator view across WhatsApp, GitHub, and heartbeat activity.</p>

      <section class="toolbar">
        <div>
          <label for="limit">Per-ingress limit</label><br />
          <input id="limit" type="number" min="1" max="20" value="3" />
        </div>
        <div class="subtle" id="status">Loading...</div>
      </section>

      <section class="auth hidden" id="auth-panel">
        <label for="token">Access password required for /api/activity</label><br />
        <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
          <input id="token" type="password" placeholder="Paste the activity password" style="min-width:320px;" />
          <button id="save-token" type="button">Save Password</button>
        </div>
      </section>

      <section class="summary" id="summary"></section>
      <div id="error"></div>
      <section id="cards"></section>
    </main>

    <script>
      const statusEl = document.getElementById("status");
      const summaryEl = document.getElementById("summary");
      const cardsEl = document.getElementById("cards");
      const errorEl = document.getElementById("error");
      const authPanelEl = document.getElementById("auth-panel");
      const tokenInputEl = document.getElementById("token");
      const limitInputEl = document.getElementById("limit");
      const saveTokenEl = document.getElementById("save-token");
      const tokenStorageKey = "smolpaws_runner_token";

      function readStoredToken() {
        return window.localStorage.getItem(tokenStorageKey) || "";
      }

      function writeStoredToken(token) {
        if (!token) {
          window.localStorage.removeItem(tokenStorageKey);
          return;
        }
        window.localStorage.setItem(tokenStorageKey, token);
      }

      function consumeHashToken() {
        const rawHash = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash;
        const params = new URLSearchParams(rawHash);
        const token = params.get("token");
        if (token) {
          writeStoredToken(token);
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function renderSummary(data) {
        const metrics = [
          ["Conversations", data.summary.total_conversations],
          ["Running", data.summary.running_count],
          ["Waiting", data.summary.waiting_count],
          ["Errors", data.summary.error_count],
          ["Stuck", data.summary.stuck_count],
          ["Pending Outbound", data.summary.pending_outbound_count],
        ];
        summaryEl.innerHTML = metrics.map(function(metric) {
          return '<div class="metric"><span class="label">' + escapeHtml(metric[0]) +
            '</span><span class="value">' + escapeHtml(metric[1]) + '</span></div>';
        }).join("");
      }

      function formatTimestamp(value) {
        if (!value) {
          return "n/a";
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }
        return date.toLocaleString();
      }

      function prettifyIngress(ingress) {
        const normalized = String(ingress || "").toLowerCase();
        if (normalized.startsWith("github")) return "GitHub";
        if (normalized.startsWith("whatsapp")) return "WhatsApp";
        if (normalized.startsWith("heartbeat")) return "Heartbeat";
        return ingress || "Other";
      }

      function groupItems(items) {
        const groups = new Map();
        items.forEach(function(item) {
          const key = prettifyIngress(item.ingress);
          if (!groups.has(key)) {
            groups.set(key, []);
          }
          groups.get(key).push(item);
        });
        return Array.from(groups.entries())
          .map(function(entry) {
            entry[1].sort(function(left, right) {
              return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
            });
            return entry;
          })
          .sort(function(left, right) {
            return new Date(right[1][0].updated_at).getTime() - new Date(left[1][0].updated_at).getTime();
          });
      }

      function renderCards(items) {
        if (!items.length) {
          cardsEl.innerHTML = '<section class="section"><div class="subtle">No conversations yet.</div></section>';
          return;
        }

        cardsEl.innerHTML = groupItems(items).map(function(group) {
          const ingress = group[0];
          const groupItemsList = group[1];
          return '<section class="section">' +
            '<div class="section-header">' +
              '<h2>' + escapeHtml(ingress) + '</h2>' +
              '<div class="section-count">' + escapeHtml(groupItemsList.length) + ' recent conversations</div>' +
            '</div>' +
            '<div class="row-list">' +
              groupItemsList.map(function(item) {
                const turn = item.latest_turn || null;
                const title = item.title || item.target;
                const detailBlocks = [
                  ["Conversation", item.id],
                  ["Latest Event", item.latest_event_kind || "n/a"],
                ];
                if (item.latest_error) {
                  detailBlocks.push(["Latest Error", item.latest_error]);
                }
                if (turn) {
                  detailBlocks.push([
                    "Latest Turn",
                    "seq " + turn.sequence + " | " + turn.status + "\\n" +
                      turn.id + "\\nupdated " + formatTimestamp(turn.updated_at),
                  ]);
                }
                return '<article class="row">' +
                  '<div class="row-top">' +
                    '<div>' +
                      '<div class="row-title">' + escapeHtml(title) + '</div>' +
                      '<div class="row-meta">' +
                        escapeHtml((item.scope_id || item.ingress) + " | " + formatTimestamp(item.updated_at) + " | live " + (item.is_live ? "yes" : "no")) +
                      '</div>' +
                    '</div>' +
                    '<span class="chip status-' + escapeHtml(item.execution_status) + '">' +
                      escapeHtml(item.execution_status) +
                    '</span>' +
                  '</div>' +
                  (item.latest_action
                    ? '<div class="row-snippet"><span class="label">Latest Action</span>' + escapeHtml(item.latest_action) + '</div>'
                    : '') +
                  (item.last_user_message
                    ? '<div class="row-snippet"><span class="label">Last User Message</span>' + escapeHtml(item.last_user_message) + '</div>'
                    : '') +
                  (item.last_assistant_message
                    ? '<div class="row-snippet"><span class="label">Last Agent Message</span>' + escapeHtml(item.last_assistant_message) + '</div>'
                    : '') +
                  '<div class="row-foot">' +
                    '<span class="mini">pending outbound ' + escapeHtml(item.pending_outbound_count) + '</span>' +
                    '<span class="mini">pending tasks ' + escapeHtml(item.pending_task_command_count) + '</span>' +
                  '</div>' +
                  '<div class="row-detail">' +
                    detailBlocks.map(function(block) {
                      return '<div class="detail"><span class="label">' + escapeHtml(block[0]) +
                        '</span><div class="value">' + escapeHtml(block[1]) + '</div></div>';
                    }).join('') +
                  '</div>' +
                '</article>';
              }).join('') +
            '</div>' +
          '</section>';
        }).join("");
      }

      async function loadActivity() {
        const limit = Math.max(1, Math.min(20, Number(limitInputEl.value || 3)));
        const token = readStoredToken();
        const headers = token ? { Authorization: "Bearer " + token } : {};
        const response = await fetch("/api/activity?limit=" + encodeURIComponent(String(limit)), {
          headers: headers,
        });
        if (response.status === 401) {
          authPanelEl.classList.remove("hidden");
          throw new Error("Access password required.");
        }
        authPanelEl.classList.add("hidden");
        if (!response.ok) {
          throw new Error("Request failed with status " + response.status);
        }
        return await response.json();
      }

      function hasActiveSelection() {
        const selection = window.getSelection();
        return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
      }

      let refreshDeferredForSelection = false;

      async function refresh() {
        if (hasActiveSelection()) {
          refreshDeferredForSelection = true;
          return;
        }
        try {
          const data = await loadActivity();
          renderSummary(data);
          renderCards(data.items);
          errorEl.textContent = "";
          statusEl.textContent =
            "Updated " + new Date(data.server_time).toLocaleTimeString() +
            " | idle for " + data.idle_seconds + "s";
        } catch (error) {
          errorEl.textContent = String(error instanceof Error ? error.message : error);
          statusEl.textContent = "Waiting for activity data";
        }
      }

      saveTokenEl.addEventListener("click", function() {
        writeStoredToken(tokenInputEl.value.trim());
        refresh();
      });

      limitInputEl.addEventListener("change", function() {
        refresh();
      });

      document.addEventListener("selectionchange", function() {
        if (refreshDeferredForSelection && !hasActiveSelection()) {
          refreshDeferredForSelection = false;
          refresh();
        }
      });

      consumeHashToken();
      tokenInputEl.value = readStoredToken();
      refresh();
      window.setInterval(refresh, 2000);
    </script>
  </body>
</html>`;
}

export function registerActivityRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  let cachedActivity: ActivityCacheEntry | undefined;
  let cachedInfos: ActivityInfosCacheEntry | undefined;

  app.get<{
    Querystring: { limit?: string | number };
    Reply: ActivityResponse | { error: string };
  }>(
    "/api/activity",
    {
      schema: {
        response: {
          200: ActivityResponseSchema,
          401: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<ActivityResponse | { error: string }> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }

      const limit = parseLimit(request.query.limit);
      const lastEventAt = deps.conversationRuntime.getLastEventAt();
      if (
        cachedActivity &&
        cachedActivity.limit === limit &&
        cachedActivity.last_event_at === lastEventAt &&
        Date.now() - cachedActivity.generated_at < ACTIVITY_CACHE_TTL_MS
      ) {
        return cachedActivity.response;
      }

      const now = Date.now();
      const infos =
        cachedInfos &&
        now - cachedInfos.generated_at < ACTIVITY_INFOS_CACHE_TTL_MS
          ? cachedInfos.items
          : await listConversationInfos(
              deps.persistenceRoot,
              deps.conversationRuntime.conversations,
              deriveExecutionStatusFromEvents,
            );
      if (!cachedInfos || cachedInfos.items !== infos) {
        cachedInfos = {
          generated_at: now,
          items: infos,
        };
      }
      const summary = createEmptySummary();
      const visibleCandidates: VisibleActivityCandidate[] = [];

      for (const info of infos) {
        const record = deps.conversationRuntime.conversations.get(info.id);
        const [events, config, turnState, pendingOutbound] = await Promise.all([
          loadConversationEvents(info, record, deps.persistenceRoot),
          loadConversationMeta(info, record, deps.persistenceRoot),
          loadConversationTurnState(info, deps),
          readQueueItems<SmolpawsOutboundMessage>(
            info.id,
            deps.persistenceRoot,
            "outbox.jsonl",
          ),
        ]);
        if (!isTrackedSmolpawsConfig(config)) {
          continue;
        }
        const isLive = Boolean(record);
        const latestTurn = getLatestTurn(turnState);
        const latestEventAt = getLatestEventTimestamp(events);
        const executionStatus = resolveExecutionStatus({
          infoStatus: events.length
            ? deriveExecutionStatusFromEvents(events)
            : info.execution_status,
          latestTurn,
          isLive,
        });
        addSummaryItem(summary, executionStatus, pendingOutbound.length > 0);
        visibleCandidates.push({
          info,
          updatedAt:
            resolveUpdatedAt(
              latestEventAt,
              latestTurn?.updated_at,
              info.updated_at,
            ) ?? info.updated_at,
          preloaded: {
            record,
            events,
            config,
            turnState,
            pendingOutbound,
          },
        });
      }

      const allItems = await Promise.all(
        visibleCandidates.map(async (candidate) =>
          await buildActivityItem(candidate.info, deps, candidate.preloaded),
        ),
      );
      const limitedItems = limitItemsPerIngress(allItems, limit);

      const response = {
        server_time: new Date().toISOString(),
        uptime_seconds: Math.floor((Date.now() - deps.serverStart) / 1000),
        idle_seconds: Math.floor(
          (Date.now() - lastEventAt) / 1000,
        ),
        items: limitedItems,
        summary,
      };
      cachedActivity = {
        limit,
        last_event_at: lastEventAt,
        generated_at: now,
        response,
      };
      return response;
    },
  );

  app.get("/activity", async (_, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderActivityPage();
  });
}
