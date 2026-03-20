export interface AgentRuntimeInput {
  prompt: string;
  conversationId?: string;
  scopeId: string;
  groupFolder?: string;
  chatJid: string;
  isControlScope: boolean;
  isMain?: boolean;
  isScheduledTask?: boolean;
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
