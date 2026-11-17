import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchToAgentServer } from '../agentServerClient.js';

test('GitHub dispatch fails closed without stable identity or relay configuration', async () => {
  const message = { event: 'issue_comment' as const, delivery_id: 'delivery-1', payload: { repository: { full_name: 'owner/repo' }, issue: { number: 7 }, comment: { body: '@smolpaws hello' } } };
  await assert.rejects(dispatchToAgentServer(message, {}), /must be configured/);
  await assert.rejects(dispatchToAgentServer({ ...message, delivery_id: undefined }, {}), /delivery identity/);
});
