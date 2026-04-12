import type { AgentRuntimeOutput } from './agent-runtime/types.js';

function normalizeComparableMessageText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function shouldSendFinalReplyAfterOutbound(
  reply: string | null | undefined,
  outboundMessages: AgentRuntimeOutput['outboundMessages'],
): boolean {
  const normalizedReply = normalizeComparableMessageText(reply ?? '');
  if (!normalizedReply) {
    return false;
  }

  const outbound = outboundMessages ?? [];
  if (outbound.length === 0) {
    return true;
  }

  const lastOutbound = outbound[outbound.length - 1];
  if (!lastOutbound || lastOutbound.kind !== 'current_thread_message') {
    return true;
  }

  const normalizedOutbound = normalizeComparableMessageText(lastOutbound.text);
  if (!normalizedOutbound) {
    return true;
  }

  if (normalizedOutbound.includes(normalizedReply)) {
    return false;
  }

  const replyWords = normalizedReply.split(/\s+/).filter(Boolean);
  const looksLikeShortLeadIn =
    replyWords.length <= 12 &&
    normalizedReply.endsWith(':') &&
    normalizedOutbound.length >= normalizedReply.length;

  if (looksLikeShortLeadIn) {
    return false;
  }

  return true;
}
