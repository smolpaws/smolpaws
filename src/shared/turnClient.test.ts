import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorTurn } from './turnClient.js';

test('monitorTurn returns the live status without fabricating a stuck result for non-owners', async () => {
  const calls: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.includes('/turns/turn-1?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'conversation-1',
          turn_id: 'turn-1',
          status: 'running',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await monitorTurn({
    baseUrl: 'https://runner.example.com',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    deliveryOwnerId: 'owner-2',
    isDeliveryOwner: false,
    fetchImpl: fetchStub,
  });

  assert.deepEqual(result, {
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    status: 'running',
    deliveredOutboundCount: 0,
    isDeliveryOwner: false,
  });
  assert.equal(calls.length, 1);
});
