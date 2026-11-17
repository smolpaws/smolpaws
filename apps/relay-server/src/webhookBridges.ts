import { createPrivateKey, sign } from 'node:crypto';
import path from 'node:path';
import type { AgentServerApp } from '../../../packages/openhands-agent-server/src/app.js';
import pino from 'pino';
import { z } from 'zod';
import { deterministicConversationId } from '../../../src/coordinator/ids.js';
import { RelayRuntime } from '../../../src/coordinator/relayRuntime.js';
import type { LaneRow } from '../../../src/coordinator/types.js';
import { buildRelayConversationDefaults } from '../../../src/shared/relayConversationDefaults.js';
import { buildEmailPrompt } from '../../email/src/inbound.js';
import { githubWorkingDir } from './repoWorkspace.js';
import { buildReplySubject, sendEmail } from '../../email/src/resendClient.js';

const githubInput = z.object({ messageId: z.string().min(1).max(512),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), issueNumber: z.number().int().positive(), installationId: z.number().int().positive().optional(), prompt: z.string().min(1) }).strict();
const emailInput = z.object({ emailId: z.string().min(1).max(512), sender: z.string().email(),
  subject: z.string().optional(), text: z.string().optional(), messageId: z.string().optional() }).strict();
const delivery = z.object({ kind: z.literal('current_thread_message'), text: z.string().min(1) });
const disclosure = '\n\n— Sent by SmolPaws, an AI agent, on behalf of its user.';

export interface WebhookBridgeOptions {
  dbDirectory: string;
  schedulerDbPath: string;
  sessionApiKey: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  tickMs?: number;
  createConversationDefaults?: Record<string, unknown>;
}

async function githubToken(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch, installationId: string | null): Promise<string> {
  if (!installationId && env.GITHUB_USER_TOKEN) return env.GITHUB_USER_TOKEN;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !installationId) throw new Error('GitHub delivery credentials are unavailable');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
  const jwt = `${input}.${sign('RSA-SHA256', Buffer.from(input), createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'))).toString('base64url')}`;
  const response = await fetcher(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smolpaws' }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub token request failed: ${response.status}`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error('GitHub token response is invalid');
  return body.token;
}

/** Product-only bridge intake; queue ownership stays outside the transpiled server. */
export function registerWebhookBridges(app: AgentServerApp['app'], options: WebhookBridgeOptions): void {
  if (!options.sessionApiKey.trim()) throw new Error('Webhook intake requires session authentication');
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const runtimes = new Map<string, RelayRuntime>();
  const defaults = options.createConversationDefaults ?? buildRelayConversationDefaults({ ingress: 'webhook' });
  const tagsFor = (runtime: RelayRuntime, lane: LaneRow): Record<string, string> =>
    runtime.scheduler.lane(lane.conversationId)?.defaults.tags as Record<string, string> ?? {};
  const githubReady = () => Boolean(env.GITHUB_USER_TOKEN || env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
  const emailReady = () => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS);

  let startup: Promise<void> | undefined;
  async function start(): Promise<void> {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Webhook relay requires a TCP listener');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    for (const platform of ['github', 'email'] as const) {
      const runtime: RelayRuntime = new RelayRuntime({ platform, serverUrl, sessionApiKey: options.sessionApiKey,
        logger: pino(), dbPath: path.join(options.dbDirectory, `${platform}-relay-v1.db`),
        tickMs: options.tickMs, schedulerDbPath: options.schedulerDbPath, createConversationDefaults: defaults,
        createConversationDefaultsFor: lane => runtime.scheduler.lane(deterministicConversationId(lane.laneKey))?.defaults ?? {},
        target: {
          isReady: platform === 'github' ? githubReady : emailReady,
          validate(lane, payload) {
            delivery.parse(payload);
            if (lane.platform !== platform) throw new Error('Webhook delivery platform mismatch');
          },
          async prepare(lane) {
            return platform === 'github' ? githubToken(env, fetcher, lane.accountId) : undefined;
          },
          async deliver(lane, payload, prepared) {
            const text = delivery.parse(payload).text + disclosure;
            if (platform === 'github') {
              const token = String(prepared);
              const response = await fetcher(`https://api.github.com/repos/${lane.chatId}/issues/${lane.threadId}/comments`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'smolpaws', 'X-GitHub-Api-Version': '2022-11-28' },
                body: JSON.stringify({ body: text }), signal: AbortSignal.timeout(15_000),
              });
              if (!response.ok) throw new Error(`GitHub delivery failed: ${response.status}`);
              const result = await response.json() as { id: number };
              return { externalMessageId: String(result.id) };
            }
            const tags = tagsFor(runtime, lane);
            const result = await sendEmail({ apiKey: env.RESEND_API_KEY!, from: env.EMAIL_FROM_ADDRESS!, to: lane.chatId,
              subject: buildReplySubject(tags.email_subject), text, inReplyTo: tags.email_message_id, references: tags.email_message_id, fetchImpl: fetcher });
            return { externalMessageId: result.id };
          },
        } });
      runtimes.set(platform, runtime);
      await runtime.start();
    }
  }
  app.addHook('onListen', async () => {
    startup = start();
    void startup.catch(error => app.log.error({ err: error }, 'Webhook relay startup failed'));
  });
  app.addHook('preClose', async () => {
    await startup?.catch(() => undefined);
    await Promise.all([...runtimes.values()].map(runtime => runtime.stop()));
  });

  app.post('/api/bridges/:platform/messages', async (request, reply) => {
    if (request.headers['x-session-api-key'] !== options.sessionApiKey) return reply.code(401).send({ detail: 'Invalid session key' });
    const platform = (request.params as { platform: string }).platform;
    if (!startup) return reply.code(503).send({ detail: 'Webhook bridge is not ready' });
    try { await startup; } catch { return reply.code(503).send({ detail: 'Webhook bridge is unavailable' }); }
    const runtime = runtimes.get(platform);
    if (!runtime || !(platform === 'github' ? githubReady() : emailReady())) return reply.code(503).send({ detail: 'Webhook bridge is not configured' });
    if (platform === 'github') {
      const parsed = githubInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ detail: 'Invalid GitHub intake' });
      const input = parsed.data;
      const lane = { laneKey: `github-relay:v1:${input.installationId ?? 'user'}:${input.repository.toLowerCase()}:${input.issueNumber}`, platform,
        accountId: input.installationId === undefined ? null : String(input.installationId), chatId: input.repository.toLowerCase(), threadId: String(input.issueNumber) };
      if (input.installationId !== undefined ? !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY : !env.GITHUB_USER_TOKEN) return reply.code(503).send({ detail: 'GitHub delivery credentials are unavailable' });
      const existing = runtime.workStore.getWorkBySourceKey('intake', `github:${lane.accountId ?? ''}:${input.messageId}`);
      if (existing && existing.laneKey !== lane.laneKey) return reply.code(409).send({ detail: 'Delivery identity belongs to another thread' });
      const workingDir = githubWorkingDir(input.repository, env);
      const registration = runtime.registerLane(lane);
      if (!existing) registration.defaults = { ...registration.defaults, ...(workingDir ? { workspace: { kind: 'LocalWorkspace', working_dir: workingDir } } : {}) };
      registration.workingDir = (registration.defaults.workspace as { working_dir: string }).working_dir;
      runtime.registerLane(lane, registration);
      await runtime.accept({ lane, message: { sourceMessageId: input.messageId,
        content: `GitHub thread: https://github.com/${input.repository}/issues/${input.issueNumber}\n\n${input.prompt}` } });
    } else {
      const parsed = emailInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ detail: 'Invalid email intake' });
      const input = parsed.data;
      const lane = { laneKey: `email-relay:v1:${input.emailId}`, platform, chatId: input.sender, threadId: input.emailId };
      // One email gets one lane, so reply threading never changes beneath an active run.
      const existing = runtime.workStore.getWorkBySourceKey('intake', `email::${input.emailId}`);
      const bound = runtime.workStore.getLane(lane.laneKey);
      if (bound && bound.chatId !== input.sender) return reply.code(409).send({ detail: 'Email identity belongs to another sender' });
      const registration = runtime.registerLane(lane);
      if (!existing) registration.defaults = { ...registration.defaults, tags: { ...((defaults.tags ?? {}) as object), email_subject: input.subject ?? '', email_message_id: input.messageId ?? '' } };
      runtime.registerLane(lane, registration);
      await runtime.accept({ lane, message: { sourceMessageId: input.emailId, content: buildEmailPrompt({ from: input.sender, subject: input.subject, text: input.text }) } });
    }
    return reply.code(202).send({ accepted: true });
  });
}
