import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LLMFactory,
  type AgentHook,
  type ChatCompletionRequest,
  type Event,
  type LLMClient,
  type MessageEvent,
  type ObservationEvent,
  type SecretRegistry,
} from '@smolpaws/agent-sdk';
import { buildConversationDirPath } from './conversationService.js';

const TRACKER_SUMMARY_CURSOR_KEY = 'tracker_summary_cursor';
const TRACKER_SUMMARY_LOG_BASENAME = 'tracker-summaries.jsonl';
const TRACKER_SUMMARY_PROFILE_ID = 'gemini-flash-summarizer';
const TRACKER_SUMMARY_MODEL = 'gemini-2.5-flash';
const TRACKER_SUMMARY_USAGE_ID = 'tracker-summary';
const MAX_EVENT_LINES = 80;
const MAX_LINE_CHARS = 280;
const MAX_PROMPT_CHARS = 16_000;
const MAX_SUMMARY_TASK_TITLES = 4;
const MAX_SUMMARY_TASK_TITLE_CHARS = 80;

export interface TrackerSummaryEntry {
  kind: 'task_tracker_plan_summary';
  created_at: string;
  conversation_id: string;
  trigger_event_id: string;
  cursor_start: number;
  cursor_end: number;
  profile_id: string;
  prompt: string;
  summary: string;
}

type TrackerSummaryCursor = {
  nextEventIndex: number;
};

type TrackerSummaryCallback = (entry: TrackerSummaryEntry) => void | Promise<void>;

export interface CreateTrackerSummaryHookOptions {
  persistenceRoot: string;
  getConversationId: () => string | undefined;
  secrets: SecretRegistry;
  onSummary?: TrackerSummaryCallback;
  llmClient?: LLMClient;
  debug?: boolean;
  seedCursorAtCurrentEvents?: boolean;
}

function clip(text: string, maxChars = MAX_LINE_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function getCursor(events: Event[], raw: unknown): TrackerSummaryCursor {
  if (!raw || typeof raw !== 'object') {
    return { nextEventIndex: 0 };
  }
  const nextEventIndex = Number((raw as { nextEventIndex?: unknown }).nextEventIndex);
  if (!Number.isFinite(nextEventIndex) || nextEventIndex < 0) {
    return { nextEventIndex: 0 };
  }
  return { nextEventIndex: Math.min(Math.trunc(nextEventIndex), events.length) };
}

function isMessageEvent(event: Event): event is MessageEvent {
  return event.kind === 'MessageEvent';
}

function isObservationEvent(event: Event): event is ObservationEvent {
  return event.kind === 'ObservationEvent';
}

function isTaskTrackerPlanObservation(event: Event): event is ObservationEvent {
  if (!isObservationEvent(event) || event.tool_name !== 'task_tracker') {
    return false;
  }
  return (event.observation as { command?: unknown }).command === 'plan';
}

function summarizeTaskList(observation: Record<string, unknown>): string | undefined {
  const taskList = Array.isArray(observation.task_list)
    ? observation.task_list as Array<Record<string, unknown>>
    : [];
  if (!taskList.length) {
    return 'task list empty';
  }
  const counts = { todo: 0, in_progress: 0, done: 0 };
  for (const task of taskList) {
    const status = task.status;
    if (status === 'todo' || status === 'in_progress' || status === 'done') {
      counts[status] += 1;
    }
  }
  const titles = taskList
    .slice(0, MAX_SUMMARY_TASK_TITLES)
    .map((task) => typeof task.title === 'string' ? clip(task.title, MAX_SUMMARY_TASK_TITLE_CHARS) : '')
    .filter(Boolean);
  const titleSuffix = titles.length ? `; tasks: ${titles.join(' | ')}` : '';
  return `todo=${counts.todo}, in_progress=${counts.in_progress}, done=${counts.done}${titleSuffix}`;
}

function getObservationSummary(observation: Record<string, unknown>): string | undefined {
  return typeof observation.summary === 'string' && observation.summary.trim()
    ? clip(observation.summary)
    : undefined;
}

function formatEventLine(event: Event): string | undefined {
  if (isMessageEvent(event)) {
    const text = event.llm_message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && 'text' in part && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (!text) return undefined;
    if (event.source === 'user') return `USER: ${clip(text)}`;
    if (event.source === 'agent') return `ASSISTANT: ${clip(text)}`;
    if (event.source === 'environment' && event.llm_message.role === 'tool') {
      return `TOOL-RESULT-MSG ${event.llm_message.name ?? 'unknown'}: ${clip(text)}`;
    }
    return `${event.source.toUpperCase()}: ${clip(text)}`;
  }

  if (event.kind === 'ActionEvent') {
    if (event.tool_name === 'task_tracker') {
      const command = typeof event.action?.command === 'string' ? event.action.command : 'unknown';
      return `TOOL-CALL task_tracker: ${command}`;
    }
    return `TOOL-CALL ${event.tool_name}`;
  }

  if (isObservationEvent(event)) {
    const observation = event.observation;
    if (event.tool_name === 'task_tracker') {
      const command = typeof observation.command === 'string' ? observation.command : 'unknown';
      const taskSummary = summarizeTaskList(observation);
      return `TOOL-RESULT task_tracker ${command}: ${taskSummary ?? 'updated task list'}`;
    }
    const summary = getObservationSummary(observation);
    return summary
      ? `TOOL-RESULT ${event.tool_name}: ${summary}`
      : `TOOL-RESULT ${event.tool_name}`;
  }

  if (event.kind === 'ConversationErrorEvent') {
    const code = typeof event.code === 'string' ? event.code : 'unknown';
    const detail = typeof event.detail === 'string' ? ` ${clip(event.detail)}` : '';
    return `ERROR ${code}:${detail}`;
  }

  return undefined;
}

function buildPrompt(lines: string[]): string {
  const joined = lines.join('\n');
  const clipped = joined.length <= MAX_PROMPT_CHARS ? joined : `${joined.slice(0, MAX_PROMPT_CHARS - 1)}…`;
  return [
    'Write an informative progress update for the human watching an autonomous coding agent.',
    'The audience wants to know what happened and where the agent is now.',
    'Output requirements:',
    '- First line: a short title line (no markdown heading syntax).',
    '- Then 3 to 6 bullet points using the bullet character •.',
    '- Include concrete work done, key findings/changes, current state, and next step or blocker if any.',
    '- Be factual and readable in chat. Do not include secrets. Do not dump raw logs.',
    '',
    'Recent event slice:',
    clipped || '(empty)',
  ].join('\n');
}

async function summarizeWithGemini(
  prompt: string,
  options: { secrets: SecretRegistry; llmClient?: LLMClient },
): Promise<string> {
  const client = options.llmClient ?? await new LLMFactory(
    {
      profileId: TRACKER_SUMMARY_PROFILE_ID,
      usageId: TRACKER_SUMMARY_USAGE_ID,
      model: TRACKER_SUMMARY_MODEL,
    },
    {
      secrets: options.secrets,
      preferredApiKeys: 'GEMINI_API_KEY',
    },
  ).createClient();
  const request: ChatCompletionRequest = {
    systemPrompt: 'You summarize autonomous coding-agent progress for a human operator.',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  let text = '';
  for await (const chunk of client.streamChat(request)) {
    if (chunk.type === 'text') {
      text += chunk.text;
    }
  }
  return text.trim();
}

async function appendTrackerSummaryLog(
  persistenceRoot: string,
  conversationId: string,
  entry: TrackerSummaryEntry,
): Promise<void> {
  const conversationDir = buildConversationDirPath(conversationId, persistenceRoot);
  await fs.mkdir(conversationDir, { recursive: true });
  const filePath = path.join(conversationDir, TRACKER_SUMMARY_LOG_BASENAME);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function createTrackerSummaryHook(options: CreateTrackerSummaryHookOptions): AgentHook {
  let inFlight = false;

  return {
    shouldStop: async ({ state, events }) => {
      if (inFlight) {
        return false;
      }

      const allEvents = events.list();
      const rawCursor = state.snapshot.values[TRACKER_SUMMARY_CURSOR_KEY];
      if (rawCursor === undefined && options.seedCursorAtCurrentEvents) {
        state.setValue(TRACKER_SUMMARY_CURSOR_KEY, { nextEventIndex: allEvents.length });
        return false;
      }
      const cursor = rawCursor === undefined
        ? { nextEventIndex: 0 }
        : getCursor(allEvents, rawCursor);
      if (cursor.nextEventIndex >= allEvents.length) {
        return false;
      }

      let triggerIndex = -1;
      for (let i = cursor.nextEventIndex; i < allEvents.length; i += 1) {
        if (isTaskTrackerPlanObservation(allEvents[i])) {
          triggerIndex = i;
        }
      }

      if (triggerIndex === -1) {
        return false;
      }

      const conversationId = options.getConversationId();
      if (!conversationId) {
        return false;
      }

      const slice = allEvents.slice(cursor.nextEventIndex, triggerIndex + 1);
      const lines = slice
        .map(formatEventLine)
        .filter((line): line is string => Boolean(line))
        .slice(-MAX_EVENT_LINES);
      const prompt = buildPrompt(lines);
      const triggerEvent = allEvents[triggerIndex];
      const nextCursor: TrackerSummaryCursor = { nextEventIndex: triggerIndex + 1 };

      inFlight = true;
      try {
        const summary = await summarizeWithGemini(prompt, {
          secrets: options.secrets,
          llmClient: options.llmClient,
        });

        if (!summary) {
          state.setValue(TRACKER_SUMMARY_CURSOR_KEY, nextCursor);
          return false;
        }

        const entry: TrackerSummaryEntry = {
          kind: 'task_tracker_plan_summary',
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
          trigger_event_id: triggerEvent.id ?? '',
          cursor_start: cursor.nextEventIndex,
          cursor_end: nextCursor.nextEventIndex,
          profile_id: TRACKER_SUMMARY_PROFILE_ID,
          prompt,
          summary,
        };

        await appendTrackerSummaryLog(options.persistenceRoot, conversationId, entry);
        state.setValue(TRACKER_SUMMARY_CURSOR_KEY, nextCursor);
        await options.onSummary?.(entry);
      } catch (error) {
        if (options.debug) {
          console.warn('[tracker-summary] Failed to summarize tracker milestone:', error);
        }
        state.setValue(TRACKER_SUMMARY_CURSOR_KEY, nextCursor);
      } finally {
        inFlight = false;
      }

      return false;
    },
  };
}

export const trackerSummaryInternals = {
  TRACKER_SUMMARY_CURSOR_KEY,
  TRACKER_SUMMARY_LOG_BASENAME,
  buildPrompt,
  formatEventLine,
  getCursor,
  isTaskTrackerPlanObservation,
  summarizeTaskList,
};
