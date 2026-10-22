import assert from 'node:assert/strict';
import test from 'node:test';
import { openaiProvider } from '../managedAgents/providers/openai.js';
import { claudeProvider } from '../managedAgents/providers/claude.js';
import type { Run } from '../managedAgents/types.js';

// Documented wire formats, checked against official API references on 2026-10-22.
// https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/methods/create
// https://platform.claude.com/docs/en/api/beta/sessions/events/list
test('OpenAI sends a hosted initial turn and requires a completed root final answer', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let turnStatus = 'waiting', phase = 'commentary';
  const send = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') return init.body?.toString().includes('input.cancel') ? new Response(null, { status: 204 }) : Response.json({ id: 'sess_fixture' });
    if (String(url).includes('/items?')) return Response.json({ data: [{ type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text: 'Verified finding' }] }], has_more: false });
    if (String(url).includes('/turns?')) return Response.json({ data: [{ id: 'turn_root', subagent_id: null, status: turnStatus }, { id: 'turn_child', subagent_id: 'child', status: 'completed' }], has_more: false });
    return Response.json({ required_actions: [] });
  }) as typeof fetch;
  const adapter = openaiProvider('fixture-openai-secret', { enabled: true, model: 'fixture-codex', network_allowed_domains: ['github.com'] }, send);
  assert.equal(await adapter.start('Approved request', {} as Run), 'sess_fixture');
  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.input, 'Approved request'); assert.equal(payload.agent.model, 'fixture-codex');
  assert.equal(payload.environment.type, 'openai_hosted'); assert.equal(payload.environment.network.access, 'restricted');
  assert.equal(new Headers(calls[0].init?.headers).get('OpenAI-Beta'), 'agents=v1');
  assert(!JSON.stringify(payload).includes('fixture-openai-secret'));
  assert.equal((await adapter.observe('sess_fixture')).state, 'awaiting_action');
  turnStatus = 'completed'; assert.equal((await adapter.observe('sess_fixture')).state, 'awaiting_action');
  phase = 'final_answer'; assert.deepEqual(await adapter.observe('sess_fixture'), { state: 'completed', text: 'Verified finding' });
  await adapter.cancel('sess_fixture');
});

test('Claude pins its agent and model, caps the session, and follows saved event pagination', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let reason = 'requires_action', open = false;
  const event = (type: string, rest = {}) => ({ type, processed_at: '2026-10-22T12:01:00Z', ...rest });
  const send = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') return Response.json({ id: 'sesn_fixture' });
    const address = new URL(String(url));
    if (!address.pathname.endsWith('/events')) return Response.json({ status: 'idle' });
    return address.searchParams.has('page') ? Response.json({ data: [
      event('agent.message', { content: [{ type: 'text', text: 'Actual result' }] }),
      ...(open ? [event('workflow_run.created', { workflow_run_id: 'workflow_open' })] : []),
      event('session.status_idle', { stop_reason: { type: reason } }),
    ], next_page: null }) : Response.json({ data: [event('user.message')], next_page: 'opaque+/=cursor' });
  }) as typeof fetch;
  const adapter = claudeProvider('fixture-claude-secret', { enabled: true, model: 'fixture-claude', agent_id: 'agent_pinned', agent_version: 3, environment_id: 'env_clean' }, 5, send);
  assert.equal(await adapter.start('Approved request', {} as Run), 'sesn_fixture');
  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.agent.version, 3); assert.equal(payload.agent.model.id, 'fixture-claude');
  assert.equal(payload.budget.max_list_cost.amount, '500'); assert.deepEqual(payload.vault_ids, []);
  assert.equal(payload.initial_events[0].type, 'user.message');
  assert(!JSON.stringify(payload).includes('fixture-claude-secret'));
  assert.equal((await adapter.observe('sesn_fixture')).state, 'awaiting_action');
  reason = 'budget_reached'; assert.equal((await adapter.observe('sesn_fixture')).state, 'budget_paused');
  reason = 'end_turn'; open = true; assert.equal((await adapter.observe('sesn_fixture')).state, 'awaiting_action');
  open = false; assert.deepEqual(await adapter.observe('sesn_fixture'), { state: 'completed', text: 'Actual result' });
  assert(calls.some(c => new URL(c.url).searchParams.get('page') === 'opaque+/=cursor'));
});
