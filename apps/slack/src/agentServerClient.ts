import type { Logger } from 'pino';
import type { SmolpawsOutboundMessage } from '../../../src/shared/runner.js';
import {
  createDeliveryOwnerId,
  monitorTurn,
  submitConversationMessage,
} from '../../../src/shared/turnClient.js';

export type { SmolpawsOutboundMessage } from '../../../src/shared/runner.js';

const DEFAULT_AGENT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;

export type DispatchResult = {
  reply?: string;
  outboundMessages: SmolpawsOutboundMessage[];
  conversationId: string;
};

export async function dispatchToAgentServer(options: {
  baseUrl: string;
  token?: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  slack: {
    team_id: string;
    channel_id: string;
    user_id: string;
    thread_ts?: string;
  };
  logger: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<DispatchResult> {
  const {
    baseUrl,
    token,
    conversationId,
    messageId,
    prompt,
    slack,
    logger,
    fetchImpl = fetch,
    sleepImpl,
  } = options;

  const deliveryOwnerId = createDeliveryOwnerId();
  const submitResult = await submitConversationMessage({
    baseUrl,
    authToken: token,
    conversationId,
    idempotencyKey: messageId,
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
      confirmation_policy: {
        kind: 'NeverConfirm',
      },
      smolpaws: {
        ingress: 'slack',
        enable_send_message: true,
        slack,
      },
    },
  });

  logger.debug(
    {
      conversationId: submitResult.conversation_id,
      turnId: submitResult.turn_id,
      isDeliveryOwner: submitResult.is_delivery_owner,
    },
    'Slack turn submitted',
  );

  const outboundMessages: SmolpawsOutboundMessage[] = [];
  const monitored = await monitorTurn({
    baseUrl,
    authToken: token,
    conversationId: submitResult.conversation_id,
    turnId: submitResult.turn_id,
    deliveryOwnerId,
    isDeliveryOwner: submitResult.is_delivery_owner,
    fetchImpl,
    sleepImpl,
    onOutboundMessage: async (outboundMessage) => {
      outboundMessages.push(outboundMessage);
    },
  });

  return {
    ...(monitored.reply ? { reply: monitored.reply } : {}),
    outboundMessages,
    conversationId: submitResult.conversation_id,
  };
}
