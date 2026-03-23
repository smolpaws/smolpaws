import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
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
