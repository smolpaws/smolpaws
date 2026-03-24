import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureLocalRunnerReady,
  isLocalRunnerBaseUrl,
  resolveRunnerBaseUrl,
} from './local-runner.js';

test('resolveRunnerBaseUrl rejects legacy /run URLs', () => {
  assert.throws(
    () => resolveRunnerBaseUrl({ SMOLPAWS_RUNNER_URL: 'https://runner.example.com/run/' } as NodeJS.ProcessEnv),
    /must not end with \/run/,
  );
});

test('isLocalRunnerBaseUrl only allows implicit localhost runner targets', () => {
  assert.equal(isLocalRunnerBaseUrl('http://127.0.0.1:8788'), true);
  assert.equal(isLocalRunnerBaseUrl('http://localhost:8788'), true);
  assert.equal(isLocalRunnerBaseUrl('https://runner.example.com'), false);
  assert.equal(
    isLocalRunnerBaseUrl('http://127.0.0.1:8788', {
      SMOLPAWS_RUNNER_URL: 'http://127.0.0.1:8788',
    } as NodeJS.ProcessEnv),
    false,
  );
});

test('ensureLocalRunnerReady returns immediately when the local runner is already ready', async () => {
  const started: string[] = [];
  const fetchStub: typeof fetch = async () => new Response(JSON.stringify({ status: 'ready' }), { status: 200 });

  const baseUrl = await ensureLocalRunnerReady(
    fetchStub,
    { RUNNER_HOST: '127.0.0.1', PORT: '8788' } as NodeJS.ProcessEnv,
    () => {
      started.push('started');
    },
  );

  assert.equal(baseUrl, 'http://127.0.0.1:8788');
  assert.deepEqual(started, []);
});

test('ensureLocalRunnerReady bootstraps a local runner when localhost is down', async () => {
  const started: string[] = [];
  let attempts = 0;
  const fetchStub: typeof fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('not ready');
    }
    return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
  };

  const baseUrl = await ensureLocalRunnerReady(
    fetchStub,
    { RUNNER_HOST: '127.0.0.1', PORT: '8788' } as NodeJS.ProcessEnv,
    () => {
      started.push('started');
    },
  );

  assert.equal(baseUrl, 'http://127.0.0.1:8788');
  assert.deepEqual(started, ['started']);
});

test('ensureLocalRunnerReady fails fast for unavailable remote runner URLs', async () => {
  const fetchStub: typeof fetch = async () => {
    throw new Error('unreachable');
  };

  await assert.rejects(
    ensureLocalRunnerReady(
      fetchStub,
      { SMOLPAWS_RUNNER_URL: 'https://runner.example.com' } as NodeJS.ProcessEnv,
      () => {
        throw new Error('should not start');
      },
    ),
    /Runner unavailable at https:\/\/runner\.example\.com/,
  );
});
