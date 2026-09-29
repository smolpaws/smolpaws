import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JevClient,
  JevError,
  choice,
  describeAnswers,
  gate,
  noul,
  score,
  type JevCallRecord,
} from './jev.js';

const sample = {
  model: 'jev-1.13.0',
  answers: {
    needsReply: { type: 'noul', noul: 0.89 },
    kind: { type: 'choice', choice: 'question', confidence: 0.98, probabilities: { question: 0.99, task: 0, chitchat: 0.01 } },
    urgency: { type: 'score', score: 0.09, confidence: 0.87, probabilities: { '0': 0.92, '1': 0.08, '2': 0 } },
  },
  usage: { input_tokens: 463, output_tokens: 78 },
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

test('ask posts state + typed questions with the bearer key and returns typed answers, usage and cost', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const calls: JevCallRecord[] = [];
  const jev = new JevClient({
    apiKey: 'test-key',
    fetch: fakeFetch((url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(sample), { status: 200 });
    }),
    onCall: (r) => calls.push(r),
  });

  const questions = {
    needsReply: noul('Does this need a reply?'),
    kind: choice('What kind', { question: 'asks', task: 'work', chitchat: 'social' }),
    urgency: score('How urgent', ['no', 'soon', 'now']),
  };
  const r = await jev.ask({ message: 'hey?' }, questions, { tag: 'unit' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key');
  const body = JSON.parse(String(seen[0].init.body));
  assert.deepEqual(body.state, { message: 'hey?' });
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.questions.kind, { type: 'choice', instructions: 'What kind', criteria: { question: 'asks', task: 'work', chitchat: 'social' } });
  assert.deepEqual(body.questions.urgency.criteria, ['no', 'soon', 'now']);

  // Typed access: the compiler knows kind is a ChoiceAnswer and needsReply a NoulAnswer.
  assert.equal(r.answers.kind.choice, 'question');
  assert.equal(r.answers.kind.confidence, 0.98);
  assert.equal(r.answers.needsReply.noul, 0.89);
  assert.equal(r.answers.urgency.score, 0.09);
  assert.equal(r.usage.input_tokens, 463);
  assert.ok(Math.abs(r.meta.costUsd - 463 / 1e6 * 0.042) < 1e-12);

  // The call log never carries the state, only shape and cost.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].questions, ['needsReply', 'kind', 'urgency']);
  assert.equal(calls[0].tag, 'unit');
  assert.equal(calls[0].inputTokens, 463);
  assert.ok(!JSON.stringify(calls[0]).includes('hey?'));
});

test('non-2xx responses raise JevError with status and a bounded body', async () => {
  const jev = new JevClient({
    apiKey: 'k',
    fetch: fakeFetch(() => new Response('x'.repeat(2000), { status: 429 })),
  });
  await assert.rejects(jev.ask('s', { q: noul('?') }), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.status, 429);
    assert.equal(e.body?.length, 500);
    return true;
  });
});

test('a per-call model override wins over the client default', async () => {
  let body: { model: string } | null = null;
  const jev = new JevClient({
    apiKey: 'k',
    model: 'jev-1.13.0',
    fetch: fakeFetch((_u, init) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(sample), { status: 200 });
    }),
  });
  await jev.ask('s', { needsReply: noul('?') }, { model: 'jev-next' });
  assert.equal(body!.model, 'jev-next');
});

test('gate maps confidence to act / confirm / escalate by the caller\'s thresholds', () => {
  const t = { floor: 0.6, actAt: 0.85 };
  assert.equal(gate(0.33, t), 'escalate');
  assert.equal(gate(0.6, t), 'confirm');
  assert.equal(gate(0.84, t), 'confirm');
  assert.equal(gate(0.85, t), 'act');
  assert.equal(gate(0.98, t), 'act');
});

test('describeAnswers renders one line per answer', () => {
  const text = describeAnswers(sample.answers as never);
  assert.equal(text, 'needsReply: yes p=0.89\nkind: question (conf 0.98)\nurgency: 0.09/2 (conf 0.87)');
});

test('rejects malformed or mismatched API answers instead of claiming typed success', async () => {
  for (const response of [
    { ...sample, usage: undefined },
    { ...sample, answers: {} },
    { ...sample, answers: { needsReply: { type: 'noul', noul: 2 } } },
    { ...sample, answers: { needsReply: sample.answers.kind } },
  ]) {
    const calls: JevCallRecord[] = [];
    const jev = new JevClient({ apiKey: 'test', onCall: r => calls.push(r),
      fetch: fakeFetch(() => new Response(JSON.stringify(response))) });
    await assert.rejects(jev.ask('state', { needsReply: noul('?') }), JevError);
    assert.equal(calls.length, 0);
  }
});

test('rejects malformed input before looking up credentials or making a request', async () => {
  const jev = new JevClient({ apiKey: 'test', fetch: fakeFetch(() => { throw new Error('must not fetch'); }) });
  await assert.rejects(jev.ask('state', { q: score('?', ['only one']) }), JevError);
  await assert.rejects(jev.ask('state', {}), JevError);
});

test('invalid confidence cannot authorize acting and invalid thresholds are rejected', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 1.01]) {
    assert.equal(gate(value, { floor: 0.6, actAt: 0.85 }), 'escalate');
  }
  for (const thresholds of [{ floor: 0.9, actAt: 0.2 }, { floor: 0, actAt: NaN }]) {
    assert.throws(() => gate(0.95, thresholds), RangeError);
  }
});

test('rejects answers outside the requested Choice and Score criteria', async () => {
  for (const answer of [
    { ...sample.answers.kind, choice: 'unknown' },
    { ...sample.answers.kind, probabilities: { question: 0.99, other: 0.01 } },
    { ...sample.answers.kind, probabilities: { question: 0.9, task: 0.9, chitchat: 0 } },
    { ...sample.answers.urgency, score: 3 },
  ]) {
    const question = answer.type === 'choice' ? choice('?', { question: 'asks', task: 'work', chitchat: 'social' }) : score('?', ['no', 'soon', 'now']);
    const jev = new JevClient({ apiKey: 'test', fetch: fakeFetch(() => new Response(JSON.stringify({ ...sample, answers: { q: answer } }))) });
    await assert.rejects(jev.ask('state', { q: question }), JevError);
  }
});

test('request timeout aborts fetch and produces no success accounting', async () => {
  const calls: JevCallRecord[] = [];
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const jev = new JevClient({ apiKey: 'test', timeoutMs: 10, onCall: r => calls.push(r),
      fetch: (async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      })) as typeof fetch });
    await assert.rejects(jev.ask('state', { q: noul('?') }), { name: 'TimeoutError' });
    assert.deepEqual(calls, []);
  } finally { clearTimeout(keepAlive); }
});

test('a response-body timeout propagates without success accounting', async () => {
  const jev = new JevClient({ apiKey: 'test', fetch: fakeFetch(() => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('Timed out', 'TimeoutError')); },
  }))) });
  await assert.rejects(jev.ask('state', { q: noul('?') }), { name: 'TimeoutError' });
});
