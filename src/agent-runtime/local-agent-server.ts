import path from 'node:path';
import pino from 'pino';
import type { ExecutionScope } from '../scope.js';
import type { RegisteredGroup } from '../types.js';
import type { AgentRuntimeInput, AgentRuntimeOutput } from './types.js';
import { GROUPS_DIR } from '../config.js';
import {
  buildVisibleTaskSnapshot,
  processSharedRunnerTaskCommand,
} from '../task-commands.js';
import { ensureLocalRunnerReady } from './local-runner.js';
import type { SmolpawsTaskCommand } from '../shared/runner.js';
import {
  claimTurnOutboundMessages,
  claimTurnTaskCommands,
  createDeliveryOwnerId,
  getTurnResult,
  getTurnStatus,
  submitConversationMessage,
  type SubmitConversationMessageResult,
  type TurnTerminalStatus,
} from '../shared/turnClient.js';

type LocalRunnerAttemptResult = AgentRuntimeOutput & {
  errorCode?: string;
};

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;
const WHATSAPP_MAX_ITERATIONS = 5000;
const TURN_POLL_INTERVAL_MS = 2_000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_STATUSES = new Set<TurnTerminalStatus>([
  'completed',
  'waiting_for_confirmation',
  'paused',
  'error',
  'stuck',
]);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

function buildPrompt(input: AgentRuntimeInput): string {
  if (!input.isScheduledTask) {
    return input.prompt;
  }
  return `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use send_message if needed to communicate with the user.]\n\n${input.prompt}`;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image_urls: string[] };

function buildMessageContent(input: AgentRuntimeInput): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text: buildPrompt(input) }];
  if (input.imageUrls?.length) {
    parts.push({ type: 'image', image_urls: input.imageUrls });
  }
  return parts;
}

function buildConversationWorkingDir(scope: ExecutionScope): string {
  return path.join(GROUPS_DIR, scope.workspaceFolder);
}

function buildSmolpawsConfig(scope: ExecutionScope) {
  return {
    ingress: 'whatsapp',
    scope_id: scope.scopeId,
    is_control_scope: scope.isControlScope,
    enable_send_message: true,
    enable_task_tools: true,
    visible_tasks: buildVisibleTaskSnapshot(scope.scopeId),
  };
}

function isRetryableRunnerFetchError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('fetch failed');
}

function formatRetryableRunnerFetchError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shouldStartFreshConversationAfterError(
  errorCode: string | undefined,
  errorMessage: string | undefined,
): boolean {
  if (errorCode === 'max_iterations_exceeded') {
    return true;
  }
  return errorCode === 'llm_bad_request' && /budget_exceeded/i.test(errorMessage ?? '');
}

async function retryRunnerOperation<T>(
  baseUrl: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isRetryableRunnerFetchError(error)) {
      throw error;
    }
    logger.warn(
      { baseUrl, operation, error: formatRetryableRunnerFetchError(error) },
      'Transient runner fetch failed; retrying once',
    );
    await ensureLocalRunnerReady();
    return await action();
  }
}

async function monitorConversationTurn(options: {
  baseUrl: string;
  deliveryOwnerId: string;
  submitResult: SubmitConversationMessageResult;
  scope: ExecutionScope;
  registeredGroups?: Record<string, RegisteredGroup>;
}): Promise<LocalRunnerAttemptResult> {
  const { baseUrl, deliveryOwnerId, submitResult, scope } = options;
  const outboundMessages: AgentRuntimeOutput['outboundMessages'] = [];
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  if (!submitResult.is_delivery_owner) {
    return {
      status: 'success',
      result: null,
      conversationId: submitResult.conversation_id,
    };
  }

  while (Date.now() < deadline) {
    const status = await retryRunnerOperation(baseUrl, 'load turn status', () =>
      getTurnStatus({
        baseUrl,
        authToken: process.env.SMOLPAWS_RUNNER_TOKEN?.trim(),
        conversationId: submitResult.conversation_id,
        turnId: submitResult.turn_id,
        deliveryOwnerId,
      }),
    );

    const taskCommands = await retryRunnerOperation(baseUrl, 'claim turn task commands', () =>
      claimTurnTaskCommands({
        baseUrl,
        authToken: process.env.SMOLPAWS_RUNNER_TOKEN?.trim(),
        conversationId: submitResult.conversation_id,
        turnId: submitResult.turn_id,
        deliveryOwnerId,
      }),
    );
    for (const command of taskCommands as SmolpawsTaskCommand[]) {
      processSharedRunnerTaskCommand(
        command,
        scope.scopeId,
        options.registeredGroups ?? {},
        logger,
      );
    }

    const outbound = await retryRunnerOperation(baseUrl, 'claim turn outbound messages', () =>
      claimTurnOutboundMessages({
        baseUrl,
        authToken: process.env.SMOLPAWS_RUNNER_TOKEN?.trim(),
        conversationId: submitResult.conversation_id,
        turnId: submitResult.turn_id,
        deliveryOwnerId,
      }),
    );
    outboundMessages.push(...outbound);

    if (TERMINAL_STATUSES.has(status.status as TurnTerminalStatus)) {
      const result = await retryRunnerOperation(baseUrl, 'load turn result', () =>
        getTurnResult({
          baseUrl,
          authToken: process.env.SMOLPAWS_RUNNER_TOKEN?.trim(),
          conversationId: submitResult.conversation_id,
          turnId: submitResult.turn_id,
        }),
      );
      if (result.error_code) {
        return {
          status: 'error',
          result: null,
          conversationId: submitResult.conversation_id,
          error: result.error_detail ?? result.error_code,
          errorCode: result.error_code,
          ...(outboundMessages.length ? { outboundMessages } : {}),
        };
      }
      return {
        status: 'success',
        result: result.reply ?? null,
        conversationId: submitResult.conversation_id,
        ...(outboundMessages.length ? { outboundMessages } : {}),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, TURN_POLL_INTERVAL_MS));
  }

  return {
    status: 'error',
    result: null,
    conversationId: submitResult.conversation_id,
    error: 'Timed out waiting for turn to finish',
  };
}

async function executeConversationAttempt(
  baseUrl: string,
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<LocalRunnerAttemptResult> {
  const deliveryOwnerId = createDeliveryOwnerId();
  const idempotencyKey = input.messageId ?? createDeliveryOwnerId();
  const createConversation = {
    agent: {
      llm: {},
      tools: DEFAULT_AGENT_TOOLS,
    },
    confirmation_policy: {
      kind: 'NeverConfirm',
    },
    workspace: {
      kind: 'local',
      working_dir: buildConversationWorkingDir(scope),
    },
    max_iterations: WHATSAPP_MAX_ITERATIONS,
    smolpaws: buildSmolpawsConfig(scope),
  };

  const submit = async () =>
    await submitConversationMessage({
      baseUrl,
      authToken: process.env.SMOLPAWS_RUNNER_TOKEN?.trim(),
      conversationId: input.conversationId ?? `${scope.scopeId}-${Date.now().toString(36)}`,
      idempotencyKey,
      deliveryOwnerId,
      userMessage: {
        role: 'user',
        content: buildMessageContent(input),
        run: true,
      },
      createConversation: {
        ...createConversation,
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      },
    });

  const submitResult = await retryRunnerOperation(
    baseUrl,
    'submit turn message',
    submit,
  );

  return await monitorConversationTurn({
    baseUrl,
    deliveryOwnerId,
    submitResult,
    scope,
    registeredGroups: options?.registeredGroups,
  });
}

export async function runLocalAgentServerAgent(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<AgentRuntimeOutput> {
  try {
    const baseUrl = await ensureLocalRunnerReady();
    const firstAttempt = await executeConversationAttempt(baseUrl, scope, input, options);
    if (
      firstAttempt.status === 'error' &&
      input.conversationId &&
      shouldStartFreshConversationAfterError(firstAttempt.errorCode, firstAttempt.error)
    ) {
      logger.warn(
        {
          scopeId: scope.scopeId,
          conversationId: input.conversationId,
          errorCode: firstAttempt.errorCode,
        },
        'Reused conversation is exhausted; starting a fresh conversation',
      );
      return await executeConversationAttempt(
        baseUrl,
        scope,
        {
          ...input,
          conversationId: undefined,
        },
        options,
      );
    }
    return firstAttempt;
  } catch (error) {
    return {
      status: 'error',
      result: null,
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
