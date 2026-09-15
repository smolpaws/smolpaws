import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_CODE_TIMEOUT_SECONDS, OPENAI_CODEX_MODELS, VERIFIED_MODELS, type OpenAISubscriptionAuth, type DeviceCode, type OAuthCredentials } from '@smolpaws/openhands-agent';

/** Only the SDK owns OAuth credentials, refresh and provider requests. */
export type SubscriptionAuth = Pick<OpenAISubscriptionAuth, 'getCredentials' | 'refreshIfNeeded' | 'startDeviceLogin' | 'pollDeviceLogin' | 'saveCredentials' | 'logout'>;
export const subscriptionStatusSchema = z.object({ vendor: z.string().default('openai'), connected: z.boolean(), account_email: z.string().nullable().default(null), expires_at: z.number().int().nullable().default(null) });
export const subscriptionDeviceStartSchema = z.object({ device_code: z.string().describe('Opaque server-side polling token.'), user_code: z.string(), verification_uri: z.string(), verification_uri_complete: z.string().nullable().default(null), expires_at: z.number().int(), interval_seconds: z.number().int() });
export const subscriptionDevicePollSchema = z.object({ device_code: z.string() });
export const subscriptionModelsSchema = z.object({ vendor: z.string().default('openai'), models: z.array(z.string()) });
export const providersSchema = z.object({ providers: z.array(z.string()) });
export const modelsSchema = z.object({ models: z.array(z.string()) });
export const verifiedModelsSchema = z.object({ models: z.record(z.string(), z.array(z.string())) });
const status = (credentials: OAuthCredentials | null = null) => subscriptionStatusSchema.parse({ connected: credentials !== null, expires_at: credentials?.expires_at ?? null });
interface PendingLogin { readonly challenge: DeviceCode; readonly expiresAt: number; readonly epoch: number }

export function registerLlmRoutes(app: FastifyInstance, auth: SubscriptionAuth): void {
  // State belongs to this server instance; provider device identifiers never leave it.
  // Map mutations are synchronous between await points (the Python asyncio lock boundary).
  const pending = new Map<string, PendingLogin>();
  const inFlight = new Set<string>();
  let epoch = 0;
  const dropExpired = () => {
    for (const [token, login] of pending) if (login.expiresAt <= Date.now()) pending.delete(token);
  };
  const catalog: Readonly<Record<string, readonly string[]>> = VERIFIED_MODELS;
  app.get('/api/llm/providers', async () => ({ providers: Object.keys(catalog).sort() }));
  app.get('/api/llm/models', async (request) => {
    const { provider } = z.object({ provider: z.string().optional() }).parse(request.query);
    return { models: [...new Set(provider === undefined ? Object.values(catalog).flat() : catalog[provider] ?? [])].sort() };
  });
  app.get('/api/llm/models/verified', async () => ({ models: catalog }));
  app.get('/api/llm/subscription/openai/models', async () => ({ vendor: 'openai', models: [...OPENAI_CODEX_MODELS].sort() }));
  app.get('/api/llm/subscription/openai/status', async () => {
    try {
      await auth.refreshIfNeeded();
      const credentials = auth.getCredentials();
      return status(credentials === null || credentials.isExpired() ? null : credentials);
    } catch {
      return status();
    }
  });
  app.post('/api/llm/subscription/openai/device/start', async (_request, reply) => {
    try {
      const challenge = await auth.startDeviceLogin();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
      dropExpired();
      pending.set(token, { challenge, expiresAt, epoch });
      return subscriptionDeviceStartSchema.parse({ device_code: token, user_code: challenge.user_code, verification_uri: challenge.verification_url, expires_at: expiresAt, interval_seconds: challenge.interval });
    } catch {
      return reply.status(500).send({ detail: 'Subscription device login could not be started' });
    }
  });
  app.post('/api/llm/subscription/openai/device/poll', async (request, reply) => {
    const { device_code: token } = subscriptionDevicePollSchema.parse(request.body);
    dropExpired();
    const login = pending.get(token);
    pending.delete(token);
    if (login === undefined) {
      if (inFlight.has(token)) return status();
      return reply.status(404).send({ detail: 'Subscription device login not found or expired' });
    }
    inFlight.add(token);
    let credentials: OAuthCredentials | null = null;
    try {
      credentials = await auth.pollDeviceLogin(login.challenge, { persist: false });
    } catch {
      // Provider bodies can contain OAuth material. Keep the normal 500 status but
      // never return an unsanitized upstream exception in an HTTP response.
      return reply.status(500).send({ detail: 'Subscription device login polling failed' });
    } finally {
      inFlight.delete(token);
      if (credentials === null && login.epoch === epoch) pending.set(token, login);
    }
    if (credentials === null || login.epoch !== epoch) return status();
    try {
      auth.saveCredentials(credentials);
      return status(credentials);
    } catch {
      return reply.status(500).send({ detail: 'Subscription credentials could not be saved' });
    }
  });
  app.post('/api/llm/subscription/openai/logout', async (_request, reply) => {
    epoch += 1;
    pending.clear();
    try {
      auth.logout();
      return status();
    } catch {
      return reply.status(500).send({ detail: 'Subscription credentials could not be removed' });
    }
  });
  app.addHook('onClose', async () => { epoch += 1; pending.clear(); });
}
