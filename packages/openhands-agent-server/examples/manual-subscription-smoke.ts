import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { createAgentServerApp } from '../src/app.js';
import { assert, waitFor } from './httpClient.js';

// Uses only the SDK-owned ~/.openhands/auth account, never Codex CLI auth or an API key.
// Temporary server state and a harmless think/finish tool round trip; no bridge or service changes.
const root = await mkdtemp(path.join(os.tmpdir(), 'subscription-smoke-'));
const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(), config: { sessionApiKey: null, conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root } });
try {
  const status = (await server.app.inject('/api/llm/subscription/openai/status')).json<{ connected: boolean }>();
  assert(status.connected, 'Connect a ChatGPT subscription through /api/llm/subscription/openai/device/start and /device/poll first.');
  const profile = { profileId: 'subscription-smoke', providerId: 'openai', model: process.env.OPENHANDS_SUBSCRIPTION_MODEL ?? 'gpt-5.5', authType: 'subscription', subscriptionVendor: 'openai', timeoutSeconds: 120 };
  assert((await server.app.inject({ method: 'POST', url: '/api/profiles/subscription-smoke', payload: profile })).statusCode === 201, 'Profile creation failed');
  const validation = (await server.app.inject({ method: 'POST', url: '/api/profiles/subscription-smoke/validate', payload: { llm: profile } })).json<{ valid: boolean }>();
  assert(validation.valid, 'Subscription profile preflight failed');
  const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: profile.profileId, tools: ['think', 'finish'], condenser: { enabled: false } }, workspace: { working_dir: root }, max_iterations: 8 } });
  assert(started.statusCode === 201, 'Conversation creation failed');
  const { id } = started.json<{ id: string }>();
  for (const marker of ['SUBSCRIPTION_FIRST_OK', 'SUBSCRIPTION_CONTINUATION_OK']) {
    await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: `Call think once to acknowledge this smoke test, then call finish with exactly ${marker}. No other work.`, run: false } });
    await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
    await waitFor(async () => {
      const info = (await server.app.inject(`/api/conversations/${id}`)).json<{ execution_status: string }>();
      assert(info.execution_status === 'finished', 'Subscription turn has not finished');
      const final = (await server.app.inject(`/api/conversations/${id}/agent_final_response`)).json<{ response: string }>();
      assert(final.response.includes(marker), 'Subscription turn did not produce the expected marker');
    }, 240_000);
  }
  const events = (await server.app.inject(`/api/conversations/${id}/events/search?limit=100`)).json<{ items: Array<{ kind: string; tool_name?: string }> }>();
  assert(events.items.filter((event) => event.kind === 'ObservationEvent' && event.tool_name === 'think').length >= 2, 'Expected a think observation in each turn');
  console.log(JSON.stringify({ ok: true, subscription_profile_validation: true, tool_round_trip: true, continuation: true, bridge_sends: false, model: profile.model }));
} finally {
  await server.app.close();
  await rm(root, { recursive: true, force: true });
}
