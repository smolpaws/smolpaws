import { submitWebhookRelay, type WebhookRelayEnv } from '../../../src/shared/webhookRelay.js';
export type EmailAgentEnv = WebhookRelayEnv;

export interface EmailDispatchInput {
  sender: string;
  subject?: string;
  text?: string;
  emailId: string;
  messageId?: string;
}

export async function dispatchEmailToAgentServer(
  input: EmailDispatchInput, env: EmailAgentEnv, fetcher: typeof fetch = fetch,
): Promise<void> {
  await submitWebhookRelay('email', input, env, fetcher);
}
