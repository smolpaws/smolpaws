import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseMessagesToLatestPerChat } from './message-loop.js';
import type { NewMessage } from './types.js';

test('collapseMessagesToLatestPerChat keeps only the newest message per chat', () => {
  const messages: NewMessage[] = [
    {
      id: 'a1',
      chat_jid: 'chat-a',
      sender: 'user-a',
      sender_name: 'User A',
      content: 'first',
      timestamp: '2026-03-24T23:10:00.000Z',
    },
    {
      id: 'b1',
      chat_jid: 'chat-b',
      sender: 'user-b',
      sender_name: 'User B',
      content: 'only',
      timestamp: '2026-03-24T23:10:10.000Z',
    },
    {
      id: 'a2',
      chat_jid: 'chat-a',
      sender: 'user-a',
      sender_name: 'User A',
      content: 'latest',
      timestamp: '2026-03-24T23:10:20.000Z',
    },
  ];

  assert.deepEqual(
    collapseMessagesToLatestPerChat(messages).map((message) => message.id),
    ['b1', 'a2'],
  );
});
