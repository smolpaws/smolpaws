import type { ToolDefinition } from '@smolpaws/agent-sdk';
import type { SmolpawsOutboundMessage } from '../shared/runner.js';

export type RunnerOutboundMessage = SmolpawsOutboundMessage;

type SendMessageArgs = {
  text: string;
};

export function createCurrentThreadMessageTool(
  onMessage: (message: RunnerOutboundMessage) => void | Promise<void>,
): ToolDefinition<SendMessageArgs, { message: string }> {
  return {
    name: 'send_message',
    description:
      'Send a message to the current ingress thread. For GitHub, this posts a comment on the current issue or pull request.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message text to send to the current thread.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    validate(input: unknown): SendMessageArgs {
      if (!input || typeof input !== 'object') {
        throw new Error('send_message requires an object argument');
      }
      const text = (input as { text?: unknown }).text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('send_message requires a non-empty text field');
      }
      return { text: text.trim() };
    },
    async execute(args: SendMessageArgs): Promise<{ message: string }> {
      await onMessage({
        kind: 'current_thread_message',
        text: args.text,
      });
      return { message: 'Message queued for delivery to the current thread.' };
    },
  };
}
