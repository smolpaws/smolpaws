import type { SmolpawsQueueMessage } from '../../../src/shared/github.js';
import { submitWebhookRelay, type WebhookRelayEnv } from '../../../src/shared/webhookRelay.js';

export async function dispatchToAgentServer(
  message: SmolpawsQueueMessage, env: WebhookRelayEnv, fetcher: typeof fetch = fetch,
): Promise<void> {
  const repository = message.payload.repository?.full_name;
  const issueNumber = message.payload.issue?.number ?? message.payload.pull_request?.number;
  const messageId = message.delivery_id;
  if (!repository || !issueNumber || !messageId) throw new Error('GitHub relay intake requires repository, thread and delivery identity');
  const prompt = (message.payload.comment?.body ?? message.payload.issue?.body ?? '').replace(/@smolpaws/gi, '').trim();
  if (!prompt) return;
  await submitWebhookRelay('github', { messageId, repository, issueNumber, prompt, installationId: message.payload.installation?.id }, env, fetcher);
}
