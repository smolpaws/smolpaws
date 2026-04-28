import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SERVER_BODY_LIMIT_BYTES,
  createAgentServerApp,
} from './app.js';
import {
  assertSafeRunnerBind,
  isLoopbackHost,
  resolveRunnerHost,
  type RunnerEnv,
} from '../runner/workspacePolicy.js';

test('resolveRunnerHost defaults to loopback', () => {
  assert.equal(resolveRunnerHost({}), '127.0.0.1');
});

test('isLoopbackHost recognizes the supported local bind hosts', () => {
  const hosts = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  const results = hosts.map(isLoopbackHost);
  assert.deepEqual(results, [true, true, true, false]);
});

test('assertSafeRunnerBind rejects non-localhost binds without a runner token', () => {
  const env: RunnerEnv = { RUNNER_HOST: '0.0.0.0' };
  assert.throws(
    () => assertSafeRunnerBind(env),
    /runner_token_required_for_non_localhost_bind/,
  );
});

test('assertSafeRunnerBind allows non-localhost binds when a runner token is configured', () => {
  const env: RunnerEnv = {
    RUNNER_HOST: '0.0.0.0',
    SMOLPAWS_RUNNER_TOKEN: 'secret-token',
  };
  assert.doesNotThrow(() => assertSafeRunnerBind(env));
});

test('assertSafeRunnerBind allows loopback binds without a runner token', () => {
  const env: RunnerEnv = { RUNNER_HOST: '127.0.0.1' };
  assert.doesNotThrow(() => assertSafeRunnerBind(env));
});

test('agent server accepts WhatsApp image-sized JSON payloads', async (t) => {
  const { app } = await createAgentServerApp();
  t.after(() => app.close());

  app.post('/__body-limit-probe', async (request) => {
    const body = request.body as { payload: string };
    return { length: body.payload.length };
  });

  const payload = 'x'.repeat(1_100_000);
  assert.ok(AGENT_SERVER_BODY_LIMIT_BYTES > payload.length);

  const response = await app.inject({
    method: 'POST',
    url: '/__body-limit-probe',
    payload: { payload },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { length: payload.length });
});
