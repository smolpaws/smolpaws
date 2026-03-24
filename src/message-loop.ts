import type { NewMessage } from './types.js';

export function collapseMessagesToLatestPerChat(messages: NewMessage[]): NewMessage[] {
  const latestByChat = new Map<string, NewMessage>();

  for (const message of messages) {
    const existing = latestByChat.get(message.chat_jid);
    if (!existing || existing.timestamp <= message.timestamp) {
      latestByChat.set(message.chat_jid, message);
    }
  }

  return [...latestByChat.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp));
}
