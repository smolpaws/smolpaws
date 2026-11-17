import type {
  GithubEventPayload,
  SmolpawsEvent,
  SmolpawsQueueMessage,
} from "../../../src/shared/github.js";
import { dispatchToAgentServer } from "./agentServerClient.js";

interface Env {
  // GitHub App (webhook-installed repos)
  GITHUB_WEBHOOK_SECRET: string;

  // GitHub user token (notifications polling for @smolpaws mentions)
  GITHUB_USER_TOKEN?: string;

  ALLOWED_ACTORS?: string;
  ALLOWED_OWNERS?: string;
  ALLOWED_REPOS?: string;
  SMOLPAWS_QUEUE: Queue<SmolpawsQueueMessage>;

  // Only applies to webhook flow (notifications have no installation id)
  ALLOWED_INSTALLATIONS?: string;
  SMOLPAWS_RELAY_SERVER_URL?: string;
  SMOLPAWS_RELAY_SERVER_API_KEY?: string;

}

const MENTION = "@smolpaws";
const AGENT_LOGIN = "smolpaws";
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

function buildNotificationLogContext(
  notification: GithubNotification,
): Record<string, unknown> {
  return {
    thread_id: notification.id ?? null,
    reason: notification.reason ?? null,
    unread: notification.unread ?? null,
    updated_at: notification.updated_at ?? null,
    last_read_at: notification.last_read_at ?? null,
    repo: notification.repository?.full_name ?? null,
    subject_type: notification.subject?.type ?? null,
    subject_title: notification.subject?.title ?? null,
    latest_comment_url: notification.subject?.latest_comment_url ?? null,
    subject_url: notification.subject?.url ?? null,
  };
}

function logNotificationDecision(
  stage: string,
  details: Record<string, unknown>,
): void {
  console.log(`github.notifications.${stage}`, details);
}

function logQueueDelivery(
  stage: string,
  details: Record<string, unknown>,
): void {
  console.log(`github.queue.${stage}`, details);
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

    if (isSelfAction(payload)) {
      return new Response("Ignored", { status: 200 });
    }

    const commentBody = getMentionBody(payload);
    if (!containsMention(commentBody) && !isOwnThread(payload)) {
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
      delivery_id: mentionIdentity ?? request.headers.get("X-GitHub-Delivery") ?? undefined,
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

function isAgentLogin(login: string | undefined): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  return lower === AGENT_LOGIN || lower === `${AGENT_LOGIN}[bot]`;
}

function isSelfAction(payload: GithubEventPayload): boolean {
  return isAgentLogin(payload.sender?.login);
}

function isOwnThread(payload: GithubEventPayload): boolean {
  return isAgentLogin(payload.issue?.user?.login)
    || isAgentLogin(payload.pull_request?.user?.login);
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
    logQueueDelivery("process.start", {
      delivery_id: message.body.delivery_id ?? null,
      ingress: message.body.meta?.ingress ?? null,
      notification_thread_id: message.body.meta?.notification_thread_id ?? null,
      repo: repoFullName,
      issue_number: issueNumber,
      installation_id: installationId ?? null,
    });
    await dispatchToAgentServer(message.body, env);
    logQueueDelivery("process.accepted", { delivery_id: message.body.delivery_id, repo: repoFullName, issue_number: issueNumber });

    message.ack();
  } catch (error) {
    console.error("Queue message processing failed", {
      delivery_id: message.body.delivery_id ?? null,
      ingress: message.body.meta?.ingress ?? null,
      notification_thread_id: message.body.meta?.notification_thread_id ?? null,
      repo: repoFullName,
      issue_number: issueNumber,
      error,
    });
    message.retry({ delaySeconds: 30 });
  }
}

type GithubNotification = {
  id?: string;
  reason?: string;
  unread?: boolean;
  updated_at?: string;
  last_read_at?: string | null;
  subject?: {
    url?: string;
    latest_comment_url?: string;
    type?: string;
    title?: string;
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
  created_at?: string;
  updated_at?: string;
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

type GithubPullRequestReview = {
  id?: number;
  body?: string | null;
  user?: { login?: string; id?: number };
  submitted_at?: string;
  pull_request_url?: string;
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

type NotificationMentionCandidate = NotificationMention & {
  timestamp?: string;
  source: string;
};

function normalizeToken(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function parseComparableTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildCommentMentionCandidate(options: {
  event: SmolpawsEvent;
  body: string;
  senderLogin?: string;
  senderId?: number;
  commentId?: number;
  issueNumber?: number;
  pullRequestNumber?: number;
  repoFullName?: string;
  ownerLogin?: string;
  timestamp?: string;
  source: string;
}): NotificationMentionCandidate | null {
  if (!containsMention(options.body)) {
    return null;
  }

  const senderLogin = options.senderLogin;
  if (!senderLogin || isAgentLogin(senderLogin)) {
    return null;
  }

  if (!options.repoFullName || !options.ownerLogin || !options.issueNumber) {
    return null;
  }

  return {
    event: options.event,
    body: options.body,
    senderLogin,
    ...(typeof options.senderId === "number" ? { senderId: options.senderId } : {}),
    ...(typeof options.commentId === "number" ? { commentId: options.commentId } : {}),
    issueNumber: options.issueNumber,
    ...(typeof options.pullRequestNumber === "number"
      ? { pullRequestNumber: options.pullRequestNumber }
      : {}),
    repoFullName: options.repoFullName,
    ownerLogin: options.ownerLogin,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    source: options.source,
  };
}

function buildIssueBodyMentionCandidate(options: {
  issue: GithubMentionIssue;
  repoFullName?: string;
  ownerLogin?: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  source: string;
}): NotificationMentionCandidate | null {
  return buildCommentMentionCandidate({
    event: "issues",
    body: options.issue.body ?? "",
    senderLogin: options.issue.user?.login,
    senderId: options.issue.user?.id,
    issueNumber: options.issueNumber ?? options.issue.number,
    pullRequestNumber: options.pullRequestNumber,
    repoFullName: options.repoFullName,
    ownerLogin: options.ownerLogin,
    source: options.source,
  });
}

function chooseBestNotificationMention(
  candidates: NotificationMentionCandidate[],
  notification: GithubNotification,
): NotificationMention | null {
  if (!candidates.length) {
    return null;
  }

  const notificationUpdatedAtMs = parseComparableTimestamp(notification.updated_at);
  const withinNotificationWindow = candidates.filter((candidate) => {
    const candidateTimestampMs = parseComparableTimestamp(candidate.timestamp);
    if (notificationUpdatedAtMs === null || candidateTimestampMs === null) {
      return false;
    }
    return candidateTimestampMs <= notificationUpdatedAtMs + 1_000;
  });

  const pool = withinNotificationWindow.length > 0 ? withinNotificationWindow : candidates;
  const sorted = pool.slice().sort((left, right) => {
    const leftTs = parseComparableTimestamp(left.timestamp) ?? Number.NEGATIVE_INFINITY;
    const rightTs = parseComparableTimestamp(right.timestamp) ?? Number.NEGATIVE_INFINITY;
    if (leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return left.source.localeCompare(right.source);
  });

  const [best] = sorted;
  if (!best) {
    return null;
  }

  const { timestamp: _timestamp, source: _source, ...mention } = best;
  return mention;
}

async function fetchGithubApiJsonOrNull<T>(options: {
  token: string;
  url: string;
  threadId?: string;
  errorLabel: string;
}): Promise<T | null> {
  const response = await githubApiFetch(options.token, options.url);
  if (!response.ok) {
    const text = await response.text();
    console.error(options.errorLabel, {
      threadId: options.threadId,
      status: response.status,
      text,
      url: options.url,
    });
    return null;
  }
  return (await response.json()) as T;
}

async function fetchNotificationMentionWithoutLatestComment(
  notification: GithubNotification,
  token: string,
): Promise<NotificationMention | null> {
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

  const subject = await fetchGithubApiJsonOrNull<GithubMentionIssue>({
    token,
    url: subjectUrl,
    threadId: notification.id,
    errorLabel: "Failed to fetch mention issue thread",
  });
  if (!subject) {
    return null;
  }

  const repoFullName =
    notification.repository?.full_name ??
    parseRepoFullNameFromApiUrl(subject.repository_url ?? subject.url ?? subjectUrl);
  const ownerLogin =
    notification.repository?.owner?.login ??
    (repoFullName ? repoFullName.split("/")[0] : undefined);
  const issueNumber =
    subject.number ??
    parseIssueOrPrNumberFromApiUrl(subject.url ?? subjectUrl);
  const pullRequestNumber =
    subject.pull_request || notification.subject?.type === "PullRequest"
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

  const candidates: NotificationMentionCandidate[] = [];
  const subjectCandidate = buildIssueBodyMentionCandidate({
    issue: subject,
    repoFullName,
    ownerLogin,
    issueNumber,
    pullRequestNumber,
    source: "subject",
  });
  if (subjectCandidate) {
    candidates.push(subjectCandidate);
  }

  const issueComments = await fetchGithubApiJsonOrNull<GithubMentionComment[]>({
    token,
    url: `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments?per_page=50&sort=updated&direction=desc`,
    threadId: notification.id,
    errorLabel: "Failed to fetch notification issue comments",
  });
  for (const comment of issueComments ?? []) {
    const candidate = buildCommentMentionCandidate({
      event: "issue_comment",
      body: comment.body ?? "",
      senderLogin: comment.user?.login,
      senderId: comment.user?.id,
      commentId: comment.id,
      issueNumber,
      pullRequestNumber,
      repoFullName,
      ownerLogin,
      timestamp: comment.updated_at ?? comment.created_at,
      source: "issue_comment",
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (pullRequestNumber) {
    const reviewComments = await fetchGithubApiJsonOrNull<GithubMentionComment[]>({
      token,
      url: `https://api.github.com/repos/${repoFullName}/pulls/${pullRequestNumber}/comments?per_page=50&sort=updated&direction=desc`,
      threadId: notification.id,
      errorLabel: "Failed to fetch notification pull request review comments",
    });
    for (const comment of reviewComments ?? []) {
      const candidate = buildCommentMentionCandidate({
        event: "pull_request_review_comment",
        body: comment.body ?? "",
        senderLogin: comment.user?.login,
        senderId: comment.user?.id,
        commentId: comment.id,
        issueNumber,
        pullRequestNumber,
        repoFullName,
        ownerLogin,
        timestamp: comment.updated_at ?? comment.created_at,
        source: "pull_request_review_comment",
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }

    const reviews = await fetchGithubApiJsonOrNull<GithubPullRequestReview[]>({
      token,
      url: `https://api.github.com/repos/${repoFullName}/pulls/${pullRequestNumber}/reviews?per_page=50`,
      threadId: notification.id,
      errorLabel: "Failed to fetch notification pull request reviews",
    });
    for (const review of reviews ?? []) {
      const candidate = buildCommentMentionCandidate({
        event: "pull_request_review_comment",
        body: review.body ?? "",
        senderLogin: review.user?.login,
        senderId: review.user?.id,
        commentId: review.id,
        issueNumber,
        pullRequestNumber,
        repoFullName,
        ownerLogin,
        timestamp: review.submitted_at,
        source: "pull_request_review",
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return chooseBestNotificationMention(candidates, notification);
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
    if (!senderLogin || isAgentLogin(senderLogin)) {
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

  return fetchNotificationMentionWithoutLatestComment(notification, token);
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
  logNotificationDecision("poll.fetched", {
    count: notifications.length,
    mention_count: notifications.filter((notification) => notification.reason === "mention").length,
  });

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
    logNotificationDecision("skip.missing_thread_id", buildNotificationLogContext(notification));
    return;
  }

  const dedupeIdentity = notificationDedupeIdentity(notification);
  if (await wasNotificationEnqueued(dedupeIdentity)) {
    logNotificationDecision("read.already_enqueued_notification", {
      ...buildNotificationLogContext(notification),
      dedupe_identity: dedupeIdentity,
    });
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const mention = await fetchNotificationMention(notification, token);
  if (!mention) {
    logNotificationDecision("read.no_valid_mention", {
      ...buildNotificationLogContext(notification),
      dedupe_identity: dedupeIdentity,
    });
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
    logNotificationDecision("read.blocked_by_allowlist", {
      ...buildNotificationLogContext(notification),
      dedupe_identity: dedupeIdentity,
      actor: mention.senderLogin,
      event: mention.event,
      issue_number: mention.issueNumber,
      repo: mention.repoFullName,
    });
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const mentionIdentity = githubMentionIdentity(payload, mention.event);
  if (mentionIdentity && await wasGithubMentionEnqueued(mentionIdentity)) {
    logNotificationDecision("read.duplicate_mention_identity", {
      ...buildNotificationLogContext(notification),
      dedupe_identity: dedupeIdentity,
      mention_identity: mentionIdentity,
      actor: mention.senderLogin,
      event: mention.event,
      issue_number: mention.issueNumber,
      repo: mention.repoFullName,
    });
    await markNotificationEnqueued(dedupeIdentity);
    await markNotificationThreadRead(threadId, token);
    return;
  }

  const queueMessage: SmolpawsQueueMessage = {
    event: mention.event,
    payload,
    delivery_id: mentionIdentity ?? dedupeIdentity,
    meta: {
      ingress: "github_notifications",
      notification_thread_id: threadId,
    },
  };

  logNotificationDecision("queue.enqueued", {
    ...buildNotificationLogContext(notification),
    dedupe_identity: dedupeIdentity,
    mention_identity: mentionIdentity ?? null,
    actor: mention.senderLogin,
    event: mention.event,
    issue_number: mention.issueNumber,
    pull_request_number: mention.pullRequestNumber ?? null,
    repo: mention.repoFullName,
  });
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
