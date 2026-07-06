/**
 * Dispatch an inbound email to the shared agent server and collect the reply.
 *
 * Mirrors the GitHub worker's agentServerClient: submit a turn via the shared
 * turnClient, monitor to terminal, and return outbound messages + final reply.
 */

import type { SmolpawsOutboundMessage } from '../../../src/shared/runner.js';
import {
  createDeliveryOwnerId,
  monitorTurn,
  submitConversationMessage,
} from '../../../src/shared/turnClient.js';
import { buildConversationId, buildEmailPrompt } from './inbound.js';

export type EmailAgentEnv = {
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
};

export type EmailDispatchInput = {
  sender: string;
  subject?: string;
  text?: string;
  /** Stable idempotency key — the Resend email id. */
  emailId: string;
};

export type EmailAgentResult = {
  reply?: string;
  outbound_messages?: SmolpawsOutboundMessage[];
} | null;

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;
const EMAIL_MAX_ITERATIONS = 1000;

function normalizeBaseUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (trimmed.endsWith('/run')) {
    throw new Error(
      'SMOLPAWS_RUNNER_URL must be the agent-server base URL and must not end with /run',
    );
  }
  return trimmed;
}

/**
 * Dispatch to the agent server. Returns `null` when the runner is not
 * configured (no SMOLPAWS_RUNNER_URL), matching the GitHub worker convention.
 */
export async function dispatchEmailToAgentServer(
  input: EmailDispatchInput,
  env: EmailAgentEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailAgentResult> {
  const baseUrl = normalizeBaseUrl(env.SMOLPAWS_RUNNER_URL);
  if (!baseUrl) {
    return null;
  }

  const conversationId = buildConversationId(input.sender);
  const prompt = buildEmailPrompt({
    from: input.sender,
    subject: input.subject,
    text: input.text,
  });
  const deliveryOwnerId = createDeliveryOwnerId();

  const submitResult = await submitConversationMessage({
    baseUrl,
    authToken: env.SMOLPAWS_RUNNER_TOKEN,
    conversationId,
    idempotencyKey: input.emailId,
    deliveryOwnerId,
    fetchImpl,
    userMessage: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      run: true,
    },
    createConversation: {
      agent: {
        llm: {},
        tools: DEFAULT_AGENT_TOOLS,
      },
      confirmation_policy: { kind: 'NeverConfirm' },
      max_iterations: EMAIL_MAX_ITERATIONS,
      smolpaws: {
        ingress: 'email_webhook',
        enable_send_message: true,
        email: {
          sender: input.sender,
          subject: input.subject ?? null,
          email_id: input.emailId,
        },
      },
    },
  });

  const outbound: SmolpawsOutboundMessage[] = [];
  const monitored = await monitorTurn({
    baseUrl,
    authToken: env.SMOLPAWS_RUNNER_TOKEN,
    conversationId: submitResult.conversation_id,
    turnId: submitResult.turn_id,
    deliveryOwnerId,
    isDeliveryOwner: submitResult.is_delivery_owner,
    fetchImpl,
    onOutboundMessage: async (m) => {
      outbound.push(m);
    },
  });

  return { reply: monitored.reply, outbound_messages: outbound };
}

/**
 * Reduce the agent result to a single email reply body. Prefers the collected
 * outbound `current_thread_message`s (joined), else the final reply.
 */
export function resolveEmailReplyBody(result: EmailAgentResult): string | undefined {
  if (!result) return undefined;
  const outbound = result.outbound_messages ?? [];
  const texts = outbound
    .filter((m) => m.kind === 'current_thread_message')
    .map((m) => (m as { text?: string }).text?.trim() ?? '')
    .filter(Boolean);
  if (texts.length > 0) {
    return texts.join('\n\n');
  }
  const reply = result.reply?.trim();
  return reply || undefined;
}
