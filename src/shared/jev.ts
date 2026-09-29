/**
 * Jev — TypeSafe AI's "System One" decision model.
 *
 * Jev never generates text. You send a `state` (string or JSON) plus typed
 * questions; it returns typed answers with calibrated probabilities, all
 * questions evaluated in parallel in one call. Use it for narrow decisions the harness makes anyway —
 * triage, routing, risk scoring — not for generation.
 *
 * Docs index (always pull fresh): https://docs.typesafe.ai/llms.txt
 * Any docs page is available as markdown by appending `.md`.
 *
 * Usage:
 *   const jev = new JevClient();                       // key from env/Keychain TYPESAFE_API_KEY
 *   const r = await jev.ask(state, {
 *     needsReply: noul('Does this message need a reply from the assistant?'),
 *     kind: choice('What kind of message is this', { question: '…', task: '…', chitchat: '…' }),
 *     urgency: score('How urgent is this message', ['not urgent', 'soon', 'blocking']),
 *   });
 *   r.answers.kind.choice, r.answers.kind.confidence, r.answers.needsReply.noul
 *
 * Rules:
 *  - Never send secrets or private memory as state. The model is closed and hosted.
 *  - For Choice/Score, gate on `confidence`, not only on the answer. Low confidence means "not enough
 *    context" and should escalate, not act. Noul has no confidence field: its
 *    value is a yes-probability, not confidence in a proposed action.
 *  - Jev is weak at math, dates, multi-hop indirection and adversarial content.
 *    Keep arithmetic in code; never make it the sole gate on untrusted input.
 */

import { z } from 'zod';

import { keychainGet } from './keychain.js';

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
/** Estimated input price for Jev 1.13, checked 2026-09-29; not a billing receipt.
 * https://docs.typesafe.ai/models — output tokens are free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

// ---- questions --------------------------------------------------------------------

export type NoulQuestion = { type: 'noul'; instructions: string };
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: readonly string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** A yes/no question. The answer is the probability that the answer is yes. */
export function noul(instructions: string): NoulQuestion {
  return { type: 'noul', instructions };
}

/** Pick one option from a set you define. `criteria` maps option → description. */
export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

/** Rate against ordered levels (index 0 = lowest). The answer is probability-weighted. */
export function score(instructions: string, levels: readonly string[]): ScoreQuestion {
  return { type: 'score', instructions, criteria: levels };
}

// ---- answers ----------------------------------------------------------------------

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Maps each question key to the answer type of that question. */
export type AnswersFor<Q extends Record<string, Question>> = {
  [K in keyof Q]: Q[K] extends NoulQuestion
    ? NoulAnswer
    : Q[K] extends ChoiceQuestion
      ? ChoiceAnswer
      : Q[K] extends ScoreQuestion
        ? ScoreAnswer
        : Answer;
};

export type JevUsage = { input_tokens: number; output_tokens: number };

export type JevResponse<Q extends Record<string, Question>> = {
  model: string;
  answers: AnswersFor<Q>;
  usage: JevUsage;
  /** Wall time of the call and the input cost derived from `usage`. */
  meta: { ms: number; costUsd: number };
};

export type JevState = string | Record<string, unknown> | readonly unknown[];

// ---- client -----------------------------------------------------------------------

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export type JevCallRecord = {
  ts: string;
  model: string;
  inputTokens: number;
  costUsd: number;
  ms: number;
  questions: string[];
  tag?: string;
};

export type JevClientOptions = {
  /** API key. Defaults to env TYPESAFE_API_KEY, then Keychain TYPESAFE_API_KEY. */
  apiKey?: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Called after every successful call; wire it to a log. Never receives the state. */
  onCall?: (record: JevCallRecord) => void;
};

const probability = z.number().min(0).max(1);
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: z.string() }),
  z.object({ type: z.literal('choice'), instructions: z.string(),
    criteria: z.record(z.string(), z.string()).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 255) }),
  z.object({ type: z.literal('score'), instructions: z.string(), criteria: z.array(z.string()).min(2).max(10) }),
]);
const requestSchema = z.object({
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(z.string(), questionSchema).refine(v => Object.keys(v).length > 0),
});
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('noul'), noul: probability }),
    z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability,
      probabilities: z.record(z.string(), probability) }),
    z.object({ type: z.literal('score'), score: z.number().min(0), confidence: probability,
      probabilities: z.record(z.string(), probability), legend: z.record(z.string(), z.string()).optional() }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

/** Validate untyped CLI input without including request content in error messages. */
export function parseJevRequest(value: unknown): { state: JevState; questions: Record<string, Question> } {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new JevError('Invalid Jev request: expected state and nonempty typed questions', null, null);
  return parsed.data;
}

export class JevClient {
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall?: (record: JevCallRecord) => void;
  private readonly explicitKey?: string;
  private keyPromise: Promise<string> | null = null;

  constructor(opts: JevClientOptions = {}) {
    this.model = opts.model ?? JEV_DEFAULT_MODEL;
    this.url = opts.url ?? JEV_API_URL;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.onCall = opts.onCall;
    this.explicitKey = opts.apiKey;
  }

  private apiKey(): Promise<string> {
    if (this.explicitKey) return Promise.resolve(this.explicitKey);
    this.keyPromise ??= (async () => {
      const fromEnv = process.env.TYPESAFE_API_KEY;
      if (fromEnv) return fromEnv;
      const fromKeychain = await keychainGet('TYPESAFE_API_KEY');
      if (fromKeychain) return fromKeychain;
      throw new JevError('No TYPESAFE_API_KEY in env or Keychain', null, null);
    })();
    return this.keyPromise;
  }

  /**
   * Evaluate `state` against `questions`. All questions see the same state and
   * are answered in parallel. Keep state + longest question under 32k tokens.
   */
  async ask<Q extends Record<string, Question>>(
    state: JevState,
    questions: Q,
    options: { model?: string; tag?: string } = {},
  ): Promise<JevResponse<Q>> {
    parseJevRequest({ state, questions });
    const model = options.model ?? this.model;
    const started = Date.now();
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model, questions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JevError(`Jev HTTP ${res.status}`, res.status, text.slice(0, 500));
    }
    const body: unknown = await res.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) throw new JevError('Invalid Jev response JSON', res.status, null);
      throw error;
    });
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new JevError('Invalid Jev response', res.status, null);
    const data = parsed.data;
    for (const [key, question] of Object.entries(questions)) {
      const answer = data.answers[key];
      if (!answer || answer.type !== question.type) throw new JevError('Jev response does not match questions', res.status, null);
      if (question.type === 'noul') continue;
      const expected = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
      const probabilities = (answer as ChoiceAnswer | ScoreAnswer).probabilities;
      if (Object.keys(probabilities).length !== expected.length || expected.some(k => !Object.hasOwn(probabilities, k)) ||
          Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01 ||
          answer.type === 'choice' && !expected.includes(answer.choice) ||
          answer.type === 'score' && answer.score > expected.length - 1) {
        throw new JevError('Jev response does not match question criteria', res.status, null);
      }
    }
    const usage = data.usage;
    const ms = Date.now() - started;
    const costUsd = (usage.input_tokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK;
    this.onCall?.({
      ts: new Date().toISOString(),
      model: data.model,
      inputTokens: usage.input_tokens,
      costUsd,
      ms,
      questions: Object.keys(questions),
      tag: options.tag,
    });
    return { model: data.model, answers: data.answers as AnswersFor<Q>, usage, meta: { ms, costUsd } };
  }
}

// ---- helpers ----------------------------------------------------------------------

/**
 * Choice/Score confidence routing (never pass a raw Noul yes-probability): act at or above `actAt`, escalate below `floor`,
 * confirm in between. Thresholds belong to the caller: higher stakes, higher `actAt`.
 */
export function gate(
  confidence: number,
  thresholds: { floor: number; actAt: number },
): 'act' | 'confirm' | 'escalate' {
  if (!Number.isFinite(thresholds.floor) || !Number.isFinite(thresholds.actAt) ||
      thresholds.floor < 0 || thresholds.actAt > 1 || thresholds.floor > thresholds.actAt) {
    throw new RangeError('Expected 0 <= floor <= actAt <= 1');
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'escalate';
  if (confidence < thresholds.floor) return 'escalate';
  if (confidence >= thresholds.actAt) return 'act';
  return 'confirm';
}

/** One line per answer, for logs and humans. */
export function describeAnswers(answers: Record<string, Answer>): string {
  return Object.entries(answers)
    .map(([key, a]) => {
      switch (a.type) {
        case 'noul':
          return `${key}: yes p=${a.noul.toFixed(2)}`;
        case 'choice':
          return `${key}: ${a.choice} (conf ${a.confidence.toFixed(2)})`;
        case 'score': {
          const top = Object.keys(a.probabilities).length - 1;
          return `${key}: ${a.score.toFixed(2)}/${top} (conf ${a.confidence.toFixed(2)})`;
        }
      }
    })
    .join('\n');
}
