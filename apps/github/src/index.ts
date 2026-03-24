import type {
  GithubEventPayload,
  SmolpawsEvent,
  SmolpawsQueueMessage,
} from "../../agent-server/src/shared/github.js";
import type {
  SmolpawsOutboundMessage,
} from "../../agent-server/src/shared/runner.js";
import { dispatchToAgentServer } from "./agentServerClient.js";

interface Env {
  // GitHub App (webhook-installed repos)
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;

  // GitHub user token (notifications polling for @smolpaws mentions)
  GITHUB_USER_TOKEN?: string;

  ALLOWED_ACTORS?: string;
  ALLOWED_OWNERS?: string;
  ALLOWED_REPOS?: string;
  SMOLPAWS_QUEUE: Queue<SmolpawsQueueMessage>;

  // Only applies to webhook flow (notifications have no installation id)
  ALLOWED_INSTALLATIONS?: string;
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
}

const MENTION = "@smolpaws";
const USER_AGENT = "smolpaws-webhook";
const NOTIFICATION_POLL_LOOKBACK_MINUTES = 30;

function buildNotificationsPollUrl(nowMs = Date.now()): string {
  const url = new URL("https://api.github.com/notifications");
  url.searchParams.set("all", "true");
  url.searchParams.set("per_page", "50");
  url.searchParams.set(
    "since",
    new Date(nowMs - (NOTIFICATION_POLL_LOOKBACK_MINUTES * 60 * 1000)).toISOString(),
  );
  return url.toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();

    if (!env.GITHUB_WEBHOOK_SECRET) {
      return new Response("Webhook secret not configured", { status: 500 });
    }

    if (!hasConfiguredAllowedActors(env)) {
      return new Response("ALLOWED_ACTORS not configured", { status: 500 });
    }

    const signature = request.headers.get("X-Hub-Signature-256");
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    const signatureValid = await verifySignature(
      rawBody,
      env.GITHUB_WEBHOOK_SECRET,
      signature,
    );

    if (!signatureValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = parseEvent(request.headers.get("X-GitHub-Event") ?? "");
    if (!event) {
      return new Response("Ignored", { status: 200 });
    }

    let payload: GithubEventPayload;
    try {
      payload = JSON.parse(rawBody) as GithubEventPayload;
    } catch (error) {
      console.error("Invalid JSON", error);
      return new Response("Invalid payload", { status: 400 });
    }

    if (!isSupportedAction(event, payload.action)) {
      return new Response("Ignored", { status: 200 });
    }

    const commentBody = getMentionBody(payload);
    if (!containsMention(commentBody)) {
      return new Response("Ignored", { status: 200 });
    }

    if (!isAllowed(payload, env)) {
      return new Response("Ignored", { status: 200 });
    }

    const installationId = payload.installation?.id;
    const repoFullName = payload.repository?.full_name;
    const issueNumber = payload.issue?.number ?? payload.pull_request?.number;
    if (!installationId || !repoFullName || !issueNumber) {
      return new Response("Missing repository context", { status: 400 });
    }

    const mentionIdentity = githubMentionIdentity(payload, event);
    if (mentionIdentity && await wasGithubMentionEnqueued(mentionIdentity)) {
      return new Response("Ignored duplicate", { status: 200 });
    }

    const queueMessage: SmolpawsQueueMessage = {
      event,
      payload,
      delivery_id: request.headers.get("X-GitHub-Delivery") ?? undefined,
      meta: { ingress: "github_webhook" },
    };

    await env.SMOLPAWS_QUEUE.send(queueMessage);
    if (mentionIdentity) {
      await markGithubMentionEnqueued(mentionIdentity);
    }

    return new Response("Queued", { status: 202 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(pollGithubNotifications(env));
  },


  async queue(
    batch: MessageBatch<SmolpawsQueueMessage>,
    env: Env,
  ): Promise<void> {
    await Promise.all(
      batch.messages.map((message) => processQueueMessage(message, env)),
    );
  },
} satisfies ExportedHandler<Env, SmolpawsQueueMessage>;

function parseList(value?: string): Set<string> {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hasConfiguredAllowedActors(env: Pick<Env, "ALLOWED_ACTORS">): boolean {
  return parseList(env.ALLOWED_ACTORS).size > 0;
}

function parseEvent(event: string): SmolpawsEvent | null {
  if (
    event === "issue_comment" ||
    event === "pull_request_review_comment" ||
    event === "issues"
  ) {
    return event;
  }
  return null;
}

function isSupportedAction(
  event: SmolpawsEvent,
  action: string | undefined,
): boolean {
  if (!action) {
    return true;
  }
  if (event === "issues") {
    return action === "opened";
  }
  return action === "created";
}

function containsMention(body: string): boolean {
  return new RegExp(`(^|\\s)${MENTION}\\b`, "i").test(body);
}

function getMentionBody(payload: GithubEventPayload): string {
  return payload.comment?.body ?? payload.issue?.body ?? "";
}

function isAllowed(payload: GithubEventPayload, env: Env): boolean {
  const allowedActors = parseList(env.ALLOWED_ACTORS);
  const allowedOwners = parseList(env.ALLOWED_OWNERS);
  const allowedRepos = parseList(env.ALLOWED_REPOS);
  const allowedInstallations = parseList(env.ALLOWED_INSTALLATIONS);

  if (!allowedActors.size) {
    return false;
  }

  const actor = payload.sender?.login?.toLowerCase();
  const owner = payload.repository?.owner?.login?.toLowerCase();
  const repo = payload.repository?.full_name?.toLowerCase();
  const installationId = payload.installation?.id?.toString();

  if (!actor || !allowedActors.has(actor)) {
    return false;
  }

  if (allowedOwners.size && (!owner || !allowedOwners.has(owner))) {
    return false;
  }

  if (allowedRepos.size && (!repo || !allowedRepos.has(repo))) {
    return false;
  }

  // Notifications-based ingestion has no installation id; this allowlist is only
  // applied when an installation id is present (i.e. GitHub App webhooks).
  if (allowedInstallations.size && installationId) {
    if (!allowedInstallations.has(installationId)) {
      return false;
    }
  }

  return true;
}

async function processQueueMessage(
  message: Message<SmolpawsQueueMessage>,
  env: Env,
): Promise<void> {
  const { payload } = message.body;
  const installationId = payload.installation?.id;
  const repoFullName = payload.repository?.full_name;
  const issueNumber = payload.issue?.number ?? payload.pull_request?.number;

  if (!repoFullName || !issueNumber) {
    console.error("Queue message missing repository context", {
      delivery_id: message.body.delivery_id,
      ingress: message.body.meta?.ingress,
    });
    message.ack();
    return;
  }

  try {
    const token = await resolveGithubToken({ env, installationId });
    const agentResult = await dispatchToAgentServer(message.body, env);
    const outboundMessages = agentResult?.outbound_messages ?? [];

    for (const outbound of outboundMessages) {
      await deliverRunnerOutboundMessage({
        token,
        repoFullName,
        issueNumber,
        outbound,
      });
    }

    const replyBody =
      agentResult?.reply ??
      (outboundMessages.length > 0
        ? undefined
        : "🐾 smolpaws heard you and is waking up. Runner is not configured yet.");

    if (replyBody && shouldPostReplyAfterOutbound(replyBody, outboundMessages)) {
      await postIssueComment({
        token,
        repoFullName,
        issueNumber,
        body: replyBody,
      });
    }

    message.ack();
  } catch (error) {
    console.error("Queue message processing failed", error);
    message.retry({ delaySeconds: 30 });
  }
}


type GithubNotification = {
  id?: string;
  reason?: string;
  subject?: {
    url?: string;
    latest_comment_url?: string;
    type?: string;
  };
  repository?: {
    full_name?: string;
    owner?: { login?: string };
  };
};

type GithubMentionComment = {
  id?: number;
  body?: string;
  user?: { login?: string; id?: number };
  issue_url?: string;
  pull_request_url?: string;
};

type GithubMentionIssue = {
  number?: number;
  title?: string;
  body?: string;
  user?: { login?: string; id?: number };
  url?: string;
  repository_url?: string;
  pull_request?: unknown;
};

type NotificationMention = {
  event: SmolpawsEvent;
  body: string;
  senderLogin: string;
  senderId?: number;
  commentId?: number;
  issueNumber: number;
  pullRequestNumber?: number;
  repoFullName: string;
  ownerLogin: string;
};

function normalizeToken(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeComparableMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function shouldPostReplyAfterOutbound(
  reply: string,
  outboundMessages: SmolpawsOutboundMessage[],
): boolean {
  const normalizedReply = normalizeComparableMessageText(reply);
  if (!normalizedReply) {
    return false;
  }
  if (outboundMessages.length === 0) {
    return true;
  }
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  if (!lastOutbound || lastOutbound.kind !== "current_thread_message") {
    return true;
  }
  const normalizedOutbound = normalizeComparableMessageText(lastOutbound.text);
  if (!normalizedOutbound) {
    return true;
  }
  if (normalizedOutbound.includes(normalizedReply)) {
    return false;
  }

  const replyWords = normalizedReply.split(/\s+/).filter(Boolean);
  const looksLikeShortLeadIn =
    replyWords.length <= 12 &&
    normalizedReply.endsWith(':') &&
    normalizedOutbound.length >= normalizedReply.length;
  if (looksLikeShortLeadIn) {
    return false;
  }

  return true;
}

async function githubApiFetch(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", USER_AGENT);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  return fetch(url, { ...init, headers });
}

async function resolveGithubToken(options: {
  env: Env;
  installationId?: number;
}): Promise<string> {
  if (options.installationId) {
    return createInstallationToken(options.installationId, options.env);
  }
  const userToken = normalizeToken(options.env.GITHUB_USER_TOKEN);
  if (!userToken) {
    throw new Error("GITHUB_USER_TOKEN not configured");
  }
  return userToken;
}

function isReviewCommentUrl(url: string): boolean {
  return url.includes("/pulls/comments/");
}

function parseRepoFullNameFromApiUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/repos\/([^/]+\/[^/]+)\//);
  return match?.[1];
}

function parseIssueOrPrNumberFromApiUrl(url?: string): number | undefined {
  if (!url) return undefined;
  const match = url.match(/\/(issues|pulls)\/(\d+)(?:$|\b)/);
  if (!match) return undefined;
  return Number(match[2]);
}

async function fetchNotificationMention(
  notification: GithubNotification,
  token: string,
): Promise<NotificationMention | null> {
  const latestCommentUrl = notification.subject?.latest_comment_url;
  if (latestCommentUrl) {
    if (!isTrustedGithubApiUrl(latestCommentUrl)) {
      console.error("Invalid latest_comment_url", {
        threadId: notification.id,
        latestCommentUrl,
      });
      return null;
    }

    const commentResponse = await githubApiFetch(token, latestCommentUrl);
    if (!commentResponse.ok) {
      const text = await commentResponse.text();
      console.error("Failed to fetch mention comment", {
        threadId: notification.id,
        status: commentResponse.status,
        text,
      });
      return null;
    }

    const comment = (await commentResponse.json()) as GithubMentionComment;
    const commentBody = comment.body ?? "";
    if (!containsMention(commentBody)) {
      return null;
    }

    const senderLogin = comment.user?.login;
    if (!senderLogin || senderLogin.toLowerCase() === "smolpaws") {
      return null;
    }

    const repoFullName =
      notification.repository?.full_name ??
      parseRepoFullNameFromApiUrl(
        comment.issue_url ?? comment.pull_request_url ?? notification.subject?.url,
      );
    const ownerLogin =
      notification.repository?.owner?.login ??
      (repoFullName ? repoFullName.split("/")[0] : undefined);
    const issueNumber = parseIssueOrPrNumberFromApiUrl(
      comment.issue_url ?? comment.pull_request_url ?? notification.subject?.url,
    );

    if (!repoFullName || !ownerLogin || !issueNumber) {
      console.error("Notification comment missing repository context", {
        threadId: notification.id,
        repoFullName,
        ownerLogin,
        issueNumber,
      });
      return null;
    }

    const event = isReviewCommentUrl(latestCommentUrl)
      ? "pull_request_review_comment"
      : "issue_comment";

    return {
      event,
      body: commentBody,
      senderLogin,
      senderId: comment.user?.id,
      commentId: comment.id,
      issueNumber,
      pullRequestNumber:
        event === "pull_request_review_comment" ? issueNumber : undefined,
      repoFullName,
      ownerLogin,
    };
  }

  const subjectUrl = notification.subject?.url;
  if (!subjectUrl) {
    return null;
  }

  if (!isTrustedGithubApiUrl(subjectUrl)) {
    console.error("Invalid notification subject url", {
      threadId: notification.id,
      subjectUrl,
    });
    return null;
  }

  const issueResponse = await githubApiFetch(token, subjectUrl);
  if (!issueResponse.ok) {
    const text = await issueResponse.text();
    console.error("Failed to fetch mention issue thread", {
      threadId: notification.id,
      status: issueResponse.status,
      text,
    });
    return null;
  }

  const issue = (await issueResponse.json()) as GithubMentionIssue;
  const body = issue.body ?? "";
  if (!containsMention(body)) {
    return null;
  }

  const senderLogin = issue.user?.login;
  if (!senderLogin || senderLogin.toLowerCase() === "smolpaws") {
    return null;
  }

  const repoFullName =
    notification.repository?.full_name ??
    parseRepoFullNameFromApiUrl(issue.repository_url ?? issue.url ?? subjectUrl);
  const ownerLogin =
    notification.repository?.owner?.login ??
    (repoFullName ? repoFullName.split("/")[0] : undefined);
  const issueNumber =
    issue.number ??
    parseIssueOrPrNumberFromApiUrl(issue.url ?? subjectUrl);
  const pullRequestNumber =
    issue.pull_request || notification.subject?.type === "PullRequest"
      ? issueNumber
      : undefined;

  if (!repoFullName || !ownerLogin || !issueNumber) {
    console.error("Notification issue missing repository context", {
      threadId: notification.id,
      repoFullName,
      ownerLogin,
      issueNumber,
    });
    return null;
  }

  return {
    event: "issues",
    body,
    senderLogin,
    senderId: issue.user?.id,
    issueNumber,
    pullRequestNumber,
    repoFullName,
    ownerLogin,
  };
}

async function markNotificationThreadRead(
  threadId: string,
  token: string,
): Promise<void> {
  const response = await githubApiFetch(
    token,
    `https://api.github.com/notifications/threads/${threadId}`,
    { method: "PATCH" },
  );
  if (!response.ok) {
    const text = await response.text();
    console.error("Failed to mark notification read", {
      threadId,
      status: response.status,
      text,
    });
  }
}

function githubMentionIdentity(payload: GithubEventPayload, event: SmolpawsEvent): string | null {
  const repo = payload.repository?.full_name?.toLowerCase();
  const issueNumber = payload.issue?.number ?? payload.pull_request?.number;
  if (!repo || !issueNumber) {
    return null;
  }
  const commentId = payload.comment?.id;
  if (typeof commentId === "number") {
    return `${event}:${repo}:comment:${commentId}`;
  }
  return `${event}:${repo}:issue:${issueNumber}`;
}

function githubMentionDedupeKey(identity: string): Request {
  return new Request(
    `https://smolpaws.internal/dedupe/github-mentions/${encodeURIComponent(identity)}`,
  );
}

async function getGithubMentionDedupeCache(): Promise<Cache> {
  return caches.open(GITHUB_MENTION_DEDUPE_CACHE);
}

async function wasGithubMentionEnqueued(identity: string): Promise<boolean> {
  const cache = await getGithubMentionDedupeCache();
  const cached = await cache.match(githubMentionDedupeKey(identity));
  return Boolean(cached);
}

async function markGithubMentionEnqueued(identity: string): Promise<void> {
  const cache = await getGithubMentionDedupeCache();
  const response = new Response("1", {
    headers: {
      "Cache-Control": `max-age=${GITHUB_MENTION_DEDUPE_TTL_SECONDS}`,
    },
  });
  await cache.put(githubMentionDedupeKey(identity), response);
}

const NOTIFICATION_POLL_CONCURRENCY = 5;
const NOTIFICATION_DEDUPE_TTL_SECONDS = 60 * 60 * 24;
const GITHUB_MENTION_DEDUPE_CACHE = "smolpaws-github-mention-dedupe";
const GITHUB_MENTION_DEDUPE_TTL_SECONDS = 60 * 60 * 24;

function isTrustedGithubApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "api.github.com";
  } catch {
    return false;
  }
}

const NOTIFICATION_DEDUPE_CACHE = "smolpaws-notification-dedupe";

function notificationDedupeIdentity(notification: GithubNotification): string {
  return (
    notification.subject?.latest_comment_url ??
    notification.subject?.url ??
    notification.id ??
    "unknown"
  );
}

function notificationDedupeKey(identity: string): Request {
  return new Request(
    `https://smolpaws.internal/dedupe/notifications/${encodeURIComponent(identity)}`,
  );
}

async function getNotificationDedupeCache(): Promise<Cache> {
  return caches.open(NOTIFICATION_DEDUPE_CACHE);
}

async function wasNotificationEnqueued(identity: string): Promise<boolean> {
  const cache = await getNotificationDedupeCache();
  const cached = await cache.match(notificationDedupeKey(identity));
  return Boolean(cached);
}

async function markNotificationEnqueued(identity: string): Promise<void> {
  const cache = await getNotificationDedupeCache();
  const response = new Response("1", {
    headers: {
      "Cache-Control": `max-age=${NOTIFICATION_DEDUPE_TTL_SECONDS}`,
    },
  });
  await cache.put(notificationDedupeKey(identity), response);
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await handler(item);
      }
    }),
  );
}


async function pollGithubNotifications(env: Env): Promise<void> {
  const token = normalizeToken(env.GITHUB_USER_TOKEN);
  if (!token) {
    return;
  }

  if (!hasConfiguredAllowedActors(env)) {
    console.error("Refusing to poll GitHub notifications without ALLOWED_ACTORS");
    return;
  }

  const response = await githubApiFetch(
    token,
    buildNotificationsPollUrl(),
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Failed to fetch GitHub notifications", {
      status: response.status,
      text,
    });
    return;
  }

  const notifications = (await response.json()) as GithubNotification[];

  await forEachWithConcurrency(
    notifications,
    NOTIFICATION_POLL_CONCURRENCY,
    async (notification) => {
      try {
        await handleNotification(notification, env, token);
      } catch (error) {
        console.error("Notification handling error", error);
      }
    },
  );
}

async function handleNotification(
  notification: GithubNotification,
  env: Env,
  token: string,
): Promise<void> {
  if (notification.reason !== "mention") {
    return;
  }

  const threadId = notification.id;
  if (!threadId) {
    return;
  }

  const dedupeIdentity = notificationDedupeIdentity(notification);
  if (await wasNotificationEnqueued(dedupeIdentity)) {
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const mention = await fetchNotificationMention(notification, token);
  if (!mention) {
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const payload: GithubEventPayload = {
    action: mention.event === "issues" ? "opened" : "created",
    sender: { login: mention.senderLogin, id: mention.senderId },
    repository: {
      full_name: mention.repoFullName,
      owner: { login: mention.ownerLogin },
    },
    issue: {
      number: mention.issueNumber,
      ...(mention.event === "issues" ? { body: mention.body } : {}),
    },
    ...(mention.commentId
      ? { comment: { body: mention.body, id: mention.commentId } }
      : {}),
    ...(mention.pullRequestNumber
      ? { pull_request: { number: mention.pullRequestNumber } }
      : {}),
  };

  if (!isAllowed(payload, env)) {
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const mentionIdentity = githubMentionIdentity(payload, mention.event);
  if (mentionIdentity && await wasGithubMentionEnqueued(mentionIdentity)) {
    await markNotificationEnqueued(dedupeIdentity);
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const queueMessage: SmolpawsQueueMessage = {
    event: mention.event,
    payload,
    meta: {
      ingress: "github_notifications",
      notification_thread_id: threadId,
    },
  };

  await env.SMOLPAWS_QUEUE.send(queueMessage);
  if (mentionIdentity) {
    await markGithubMentionEnqueued(mentionIdentity);
  }
  await markNotificationEnqueued(dedupeIdentity);
  await markNotificationThreadRead(threadId, token);
}



async function verifySignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
): Promise<boolean> {
  const [algorithm, signature] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !signature) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const digestHex = bufferToHex(digest);
  return timingSafeEqual(`sha256=${digestHex}`, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createInstallationToken(
  installationId: number,
  env: Env,
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials not configured");
  }

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to get installation token: ${message}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64UrlEncode(signature);
  return `${signingInput}.${encodedSignature}`;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type ParsedPem = {
  label: string;
  der: Uint8Array;
};

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.from([length]);
  }
  const octets: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.from([0x80 | octets.length, ...octets]);
}

function encodeDerSequence(contents: Uint8Array): Uint8Array {
  const length = encodeDerLength(contents.length);
  const result = new Uint8Array(1 + length.length + contents.length);
  result[0] = 0x30;
  result.set(length, 1);
  result.set(contents, 1 + length.length);
  return result;
}

function encodeDerIntegerZero(): Uint8Array {
  return Uint8Array.from([0x02, 0x01, 0x00]);
}

function encodeDerOctetString(contents: Uint8Array): Uint8Array {
  const length = encodeDerLength(contents.length);
  const result = new Uint8Array(1 + length.length + contents.length);
  result[0] = 0x04;
  result.set(length, 1);
  result.set(contents, 1 + length.length);
  return result;
}

function concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, array) => sum + array.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function wrapPkcs1RsaPrivateKeyInPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // PKCS#8 PrivateKeyInfo ::= SEQUENCE {
  //   version                   INTEGER,
  //   privateKeyAlgorithm       AlgorithmIdentifier,
  //   privateKey                OCTET STRING
  // }
  // rsaEncryption OID = 1.2.840.113549.1.1.1 with NULL params.
  const rsaAlgorithmIdentifier = Uint8Array.from([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  return encodeDerSequence(
    concatUint8Arrays(
      encodeDerIntegerZero(),
      rsaAlgorithmIdentifier,
      encodeDerOctetString(pkcs1Der),
    ),
  );
}

function parsePem(pem: string): ParsedPem {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const match = normalized.match(
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END \1-----/,
  );
  if (!match) {
    throw new Error("Invalid GitHub App private key PEM format");
  }
  const [, label, body] = match;
  const base64Body = body.replace(/\s+/g, "");
  const binary = atob(base64Body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    der[i] = binary.charCodeAt(i);
  }
  return { label, der };
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const parsed = parsePem(pem);
  if (parsed.label === "PRIVATE KEY") {
    return copyToArrayBuffer(parsed.der);
  }
  if (parsed.label === "RSA PRIVATE KEY") {
    const wrapped = wrapPkcs1RsaPrivateKeyInPkcs8(parsed.der);
    return copyToArrayBuffer(wrapped);
  }
  throw new Error(`Unsupported GitHub App private key label: ${parsed.label}`);
}

async function postIssueComment(options: {
  token: string;
  repoFullName: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${options.repoFullName}/issues/${options.issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: options.body }),
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to post comment: ${message}`);
  }
}

async function deliverRunnerOutboundMessage(options: {
  token: string;
  repoFullName: string;
  issueNumber: number;
  outbound: SmolpawsOutboundMessage;
}): Promise<void> {
  if (options.outbound.kind === "current_thread_message") {
    await postIssueComment({
      token: options.token,
      repoFullName: options.repoFullName,
      issueNumber: options.issueNumber,
      body: options.outbound.text,
    });
    return;
  }

  throw new Error(
    `Unsupported outbound message kind: ${(options.outbound as { kind?: string }).kind ?? "unknown"}`,
  );
}
