/**
 * Resend inbound email ingress — Cloudflare Worker.
 *
 * Flow:
 *   1. POST /webhooks/resend
 *   2. Verify the Svix webhook signature (reject spoofed events).
 *   3. Only handle `email.received`; ignore everything else with 200.
 *   4. Level-1 strict allowlist: drop (200, no processing) anything not from
 *      an allowed sender. Fail closed on an empty allowlist.
 *   5. Dedup by email id (Cache API), then enqueue and return 202 fast so
 *      Svix gets a prompt 2xx.
 *   6. Queue consumer fetches the full email, dispatches to the agent server,
 *      and emails the reply back through Resend.
 *
 * This mirrors apps/github: a standalone webhook Worker (not a socket bridge),
 * because Resend pushes inbound email to us rather than exposing a socket.
 */

import { verifySvixSignature } from './svix.js';
import {
  decideAllowlist,
  htmlToText,
  parseAllowedSenders,
  type ResendWebhookEvent,
} from './inbound.js';
import { checkInboundAuth, domainOf } from './authcheck.js';
import {
  dispatchEmailToAgentServer,
  resolveEmailReplyBody,
  type EmailAgentEnv,
} from './agentDispatch.js';
import {
  buildReplySubject,
  retrieveReceivedEmail,
  sendEmail,
} from './resendClient.js';

export interface Env extends EmailAgentEnv {
  /** Svix signing secret from the Resend webhook (whsec_...). */
  RESEND_WEBHOOK_SECRET: string;
  /** Resend API key able to read received emails and send replies. */
  RESEND_API_KEY: string;
  /** Comma-separated allowlist of permitted sender addresses. */
  EMAIL_ALLOWED_SENDERS: string;
  /** From address for replies (default smolpaws@mail.enyst.org). */
  EMAIL_FROM_ADDRESS?: string;
  /** Inbound email queue. */
  EMAIL_QUEUE: Queue<EmailQueueMessage>;
}

export type EmailQueueMessage = {
  emailId: string;
  sender: string;
  subject?: string;
  messageId?: string;
};

const WEBHOOK_PATH = '/webhooks/resend';
const DEFAULT_FROM = 'smolpaws <smolpaws@mail.enyst.org>';
const DEDUPE_CACHE = 'smolpaws-email-dedupe';
const DEDUPE_TTL_SECONDS = 60 * 60 * 24;

function log(stage: string, details: Record<string, unknown>): void {
  console.log(`email.${stage}`, details);
}

/**
 * Mask a sender address for logs — email addresses are PII and Worker logs may
 * flow to a sink with its own retention. Keeps enough to debug the allowlist
 * boundary (first char of local part + domain) without logging the full PII.
 * e.g. `engel@enyst.org` → `e***@enyst.org`.
 */
function maskSender(sender: string): string {
  if (!sender) return '(none)';
  const at = sender.indexOf('@');
  if (at <= 0) return '***';
  return `${sender[0]}***${sender.slice(at)}`;
}

const RETRY_BASE_DELAY_SECONDS = 30;
const RETRY_MAX_DELAY_SECONDS = 900;

function retryDelaySeconds(attempts: number): number {
  const attempt = Math.max(1, attempts);
  return Math.min(RETRY_BASE_DELAY_SECONDS * 2 ** (attempt - 1), RETRY_MAX_DELAY_SECONDS);
}

function dedupeKey(emailId: string): Request {
  return new Request(
    `https://smolpaws.internal/dedupe/email/${encodeURIComponent(emailId)}`,
  );
}

async function wasEnqueued(emailId: string): Promise<boolean> {
  const cache = await caches.open(DEDUPE_CACHE);
  return Boolean(await cache.match(dedupeKey(emailId)));
}

async function markEnqueued(emailId: string): Promise<void> {
  const cache = await caches.open(DEDUPE_CACHE);
  await cache.put(
    dedupeKey(emailId),
    new Response('1', {
      headers: { 'Cache-Control': `max-age=${DEDUPE_TTL_SECONDS}` },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method !== 'POST' || url.pathname !== WEBHOOK_PATH) {
      return new Response('Not found', { status: 404 });
    }

    if (!env.RESEND_WEBHOOK_SECRET || !env.RESEND_API_KEY) {
      log('config.error', { reason: 'missing_secret_or_api_key' });
      return new Response('Email ingress not configured', { status: 500 });
    }

    const rawBody = await request.text();

    const verification = await verifySvixSignature({
      secret: env.RESEND_WEBHOOK_SECRET,
      headers: {
        id: request.headers.get('svix-id'),
        timestamp: request.headers.get('svix-timestamp'),
        signature: request.headers.get('svix-signature'),
      },
      body: rawBody,
    });
    if (!verification.valid) {
      log('signature.invalid', { reason: verification.reason });
      return new Response('Invalid signature', { status: 401 });
    }

    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(rawBody) as ResendWebhookEvent;
    } catch {
      return new Response('Invalid payload', { status: 400 });
    }

    // Only inbound receipts are actionable; ack everything else.
    if (event.type !== 'email.received' || !event.data) {
      log('ignored', { type: event.type });
      return new Response('Ignored', { status: 200 });
    }

    // Level-1 strict allowlist — the security boundary.
    const allowed = parseAllowedSenders(env.EMAIL_ALLOWED_SENDERS);
    const decision = decideAllowlist(event.data.from, allowed);
    if (!decision.allowed) {
      // Drop silently with 200 so Resend does not retry. No agent processing.
      log('rejected', { sender: maskSender(decision.sender), reason: decision.reason });
      return new Response('OK', { status: 200 });
    }

    const emailId = event.data.email_id;
    if (!emailId) {
      log('rejected', { reason: 'missing_email_id' });
      return new Response('OK', { status: 200 });
    }

    if (await wasEnqueued(emailId)) {
      log('duplicate', { emailId });
      return new Response('Ignored duplicate', { status: 200 });
    }

    await env.EMAIL_QUEUE.send({
      emailId,
      sender: decision.sender,
      subject: event.data.subject,
      messageId: event.data.message_id,
    });
    await markEnqueued(emailId);

    log('queued', { emailId, sender: maskSender(decision.sender) });
    return new Response('Queued', { status: 202 });
  },

  async queue(
    batch: MessageBatch<EmailQueueMessage>,
    env: Env,
  ): Promise<void> {
    await Promise.all(batch.messages.map((message) => processMessage(message, env)));
  },
} satisfies ExportedHandler<Env, EmailQueueMessage>;

async function processMessage(
  message: Message<EmailQueueMessage>,
  env: Env,
): Promise<void> {
  const { emailId, sender } = message.body;
  try {
    log('process.start', { emailId, sender: maskSender(sender) });

    // Fetch full content (webhook carried only metadata).
    const email = await retrieveReceivedEmail({
      apiKey: env.RESEND_API_KEY,
      emailId,
    });

    // Authentication gate: the allowlist trusts the `From` address, which can
    // be spoofed. Require the upstream receiver (SES) to have authenticated the
    // message — spam/virus PASS + DMARC pass aligned to the sender's domain —
    // before any agent dispatch. Drop (ack, no retry) otherwise.
    const authVerdict = checkInboundAuth({
      headers: email.headers,
      senderDomain: domainOf(sender),
    });
    if (!authVerdict.authenticated) {
      log('auth.rejected', {
        emailId,
        sender: maskSender(sender),
        reason: authVerdict.reason,
      });
      message.ack();
      return;
    }

    // Prefer plain text; fall back to text extracted from HTML for HTML-only
    // emails so the agent still gets the content.
    const body = email.text?.trim() ? email.text : htmlToText(email.html);

    const agentResult = await dispatchEmailToAgentServer(
      {
        sender,
        subject: email.subject ?? message.body.subject,
        text: body,
        emailId,
      },
      env,
    );

    const replyBody = resolveEmailReplyBody(agentResult);

    if (agentResult === null) {
      log('process.no_runner', { emailId });
      message.ack();
      return;
    }

    if (replyBody) {
      const fromAddress = env.EMAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM;
      const originalMessageId = email.message_id ?? message.body.messageId;
      await sendEmail({
        apiKey: env.RESEND_API_KEY,
        from: fromAddress,
        to: sender,
        subject: buildReplySubject(email.subject ?? message.body.subject),
        text: replyBody,
        inReplyTo: originalMessageId,
        references: originalMessageId,
      });
      log('process.replied', { emailId, sender: maskSender(sender) });
    } else {
      log('process.no_reply', { emailId });
    }

    message.ack();
  } catch (error) {
    const delaySeconds = retryDelaySeconds(message.attempts ?? 1);
    log('process.error', { emailId, error: String(error), delaySeconds });
    message.retry({ delaySeconds });
  }
}
