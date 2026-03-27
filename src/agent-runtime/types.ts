export interface AgentRuntimeInput {
  prompt: string;
  messageId?: string;
  conversationId?: string;
  scopeId: string;
  groupFolder?: string;
  chatJid: string;
  isControlScope: boolean;
  isMain?: boolean;
  isScheduledTask?: boolean;
  /** Base64 data URLs for images attached to this message (e.g. "data:image/jpeg;base64,...") */
  imageUrls?: string[];
}

export interface AgentRuntimeOutput {
  status: 'success' | 'error';
  result: string | null;
  conversationId?: string;
  error?: string;
  outboundMessages?: Array<{
    kind: 'current_thread_message';
    text: string;
  }>;
}
