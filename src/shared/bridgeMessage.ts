import type { RelayCommand } from '../coordinator/relayCommands.js';

export type IncomingMessage = {
  /** Trusted standalone bridge command, recognized before adding conversation history. */
  command?: RelayCommand;
  /** Stable conversation ID for agent-server (e.g. 'discord-dm-12345'). */
  conversationId: string;
  /** The user's prompt text, stripped of triggers/mentions. */
  prompt: string;
  /** Platform message ID for idempotency. */
  messageId?: string;
  /** Platform-specific metadata passed to createConversation. */
  platformContext?: Record<string, unknown>;
};

export type ReplyContext = {
  /** The original incoming message — adapter stores whatever it needs. */
  // Platform-specific original message — subclasses cast at use sites.
  original: unknown;
  /** Conversation ID for logging. */
  conversationId: string;
};
