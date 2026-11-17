export interface WebhookRelayEnv {
  SMOLPAWS_RELAY_SERVER_URL?: string;
  SMOLPAWS_RELAY_SERVER_API_KEY?: string;
}

/** The Worker acknowledges its queue only after the host commits durable intake. */
export async function submitWebhookRelay(
  platform: 'github' | 'email', payload: unknown, env: WebhookRelayEnv,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const base = env.SMOLPAWS_RELAY_SERVER_URL?.trim().replace(/\/+$/, '');
  const key = env.SMOLPAWS_RELAY_SERVER_API_KEY?.trim();
  if (!base || !key) throw new Error('Webhook relay endpoint and session key must be configured');
  const response = await fetcher(`${base}/api/bridges/${platform}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-api-key': key },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 202) throw new Error(`Webhook relay rejected intake: ${response.status}`);
  const receipt = await response.json() as { accepted?: unknown };
  if (receipt.accepted !== true) throw new Error('Webhook relay acceptance is unconfirmed');
}
