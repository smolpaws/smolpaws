import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../index.js';
import type {
  GithubEventPayload,
  SmolpawsQueueMessage,
} from '../../../agent-server/src/shared/github.js';

type TestEnv = {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_USER_TOKEN?: string;
  ALLOWED_ACTORS?: string;
  ALLOWED_OWNERS?: string;
  ALLOWED_REPOS?: string;
  ALLOWED_INSTALLATIONS?: string;
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
  SMOLPAWS_QUEUE: {
    send(message: SmolpawsQueueMessage): Promise<void>;
  };
};

type MockResponse = {
  status?: number;
  body?: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createSignedWebhookRequest(body: unknown, secret: string): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return new Request('https://smolpaws.liberty-labs.org/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': `sha256=${signature}`,
    },
    body: rawBody,
  });
}

function createMockCache(): Cache {
  const store = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const key =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      return store.get(key);
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      const key =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      store.set(key, response);
    },
    async delete(): Promise<boolean> {
      throw new Error('not implemented');
    },
    async keys(): Promise<ReadonlyArray<Request>> {
      throw new Error('not implemented');
    },
    async matchAll(): Promise<ReadonlyArray<Response>> {
      return [];
    },
    async add(): Promise<void> {
      throw new Error('not implemented');
    },
    async addAll(): Promise<void> {
      throw new Error('not implemented');
    },
  };
}

async function runScheduled(options: {
  notifications: unknown[];
  responses: Record<string, MockResponse>;
  cache?: Cache;
  env?: Partial<TestEnv>;
}): Promise<{
  sent: SmolpawsQueueMessage[];
  fetchCalls: Array<{ url: string; method: string }>;
}> {
  const sent: SmolpawsQueueMessage[] = [];
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = options.cache ?? createMockCache();

  globalThis.caches = {
    open: async () => cache,
    delete: async () => false,
    has: async () => true,
    keys: async () => ['smolpaws-notification-dedupe'],
    match: async () => undefined,
  } as CacheStorage;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });

    if (url.startsWith('https://api.github.com/notifications?')) {
      return jsonResponse(options.notifications);
    }

    const mock = options.responses[url];
    if (mock) {
      return jsonResponse(mock.body, mock.status ?? 200);
    }

    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as typeof fetch;

  try {
    const env: TestEnv = {
      GITHUB_WEBHOOK_SECRET: 'secret',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'pem',
      GITHUB_USER_TOKEN: 'user-token',
      ALLOWED_ACTORS: 'enyst',
      ALLOWED_OWNERS: 'enyst',
      SMOLPAWS_QUEUE: {
        async send(message: SmolpawsQueueMessage): Promise<void> {
          sent.push(message);
        },
      },
      ...options.env,
    };

    const waiters: Promise<void>[] = [];
    const ctx = {
      waitUntil(promise: Promise<void>): void {
        waiters.push(promise);
      },
      passThroughOnException(): void {},
    } as ExecutionContext;

    await worker.scheduled?.({} as ScheduledController, env as never, ctx);
    await Promise.all(waiters);

    return { sent, fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

test('scheduled notifications queue issue-body mentions when latest_comment_url is missing', async () => {
  const threadUrl = 'https://api.github.com/repos/enyst/OpenHands-Tab/issues/123';
  const { sent, fetchCalls } = await runScheduled({
    notifications: [
      {
        id: 'thread-1',
        reason: 'mention',
        subject: {
          url: threadUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/OpenHands-Tab',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [threadUrl]: {
        body: {
          number: 123,
          title: 'Please help',
          body: '@smolpaws check this issue',
          user: { login: 'enyst', id: 7 },
          url: threadUrl,
          repository_url: 'https://api.github.com/repos/enyst/OpenHands-Tab',
        },
      },
      'https://api.github.com/notifications/threads/thread-1': {
        body: {},
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    event: 'issues',
    payload: {
      action: 'opened',
      sender: { login: 'enyst', id: 7 },
      repository: {
        full_name: 'enyst/OpenHands-Tab',
        owner: { login: 'enyst' },
      },
      issue: {
        number: 123,
        body: '@smolpaws check this issue',
      },
    },
    meta: {
      ingress: 'github_notifications',
      notification_thread_id: 'thread-1',
    },
  });
  assert.ok(
    fetchCalls.some((call) => {
      if (!call.url.startsWith('https://api.github.com/notifications?')) {
        return false;
      }
      const url = new URL(call.url);
      return url.searchParams.get('all') === 'true' && url.searchParams.has('since');
    }),
    'A call to the notifications API with all=true and since parameters was not made.',
  );
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.url === 'https://api.github.com/notifications/threads/thread-1' &&
        call.method === 'PATCH',
    ),
  );
});

test('scheduled notifications still queue recent mention notifications that are already read', async () => {
  const commentUrl = 'https://api.github.com/repos/enyst/llm-playground/issues/comments/77';
  const { sent } = await runScheduled({
    notifications: [
      {
        id: 'thread-read-1',
        unread: false,
        reason: 'mention',
        updated_at: new Date().toISOString(),
        subject: {
          url: 'https://api.github.com/repos/enyst/llm-playground/issues/11',
          latest_comment_url: commentUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/llm-playground',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [commentUrl]: {
        body: {
          id: 77,
          body: '@smolpaws recent-but-read mention',
          user: { login: 'enyst', id: 8 },
          issue_url: 'https://api.github.com/repos/enyst/llm-playground/issues/11',
        },
      },
      'https://api.github.com/notifications/threads/thread-read-1': {
        body: {},
      },
    },
  });

  assert.deepEqual(sent, [
    {
      event: 'issue_comment',
      payload: {
        action: 'created',
        sender: { login: 'enyst', id: 8 },
        repository: {
          full_name: 'enyst/llm-playground',
          owner: { login: 'enyst' },
        },
        issue: {
          number: 11,
        },
        comment: {
          id: 77,
          body: '@smolpaws recent-but-read mention',
        },
      },
      meta: {
        ingress: 'github_notifications',
        notification_thread_id: 'thread-read-1',
      },
    },
  ]);
});

test('webhook mentions fail closed when ALLOWED_ACTORS is missing', async () => {
  const sent: SmolpawsQueueMessage[] = [];
  const env: TestEnv = {
    GITHUB_WEBHOOK_SECRET: 'secret',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'pem',
    SMOLPAWS_QUEUE: {
      async send(message: SmolpawsQueueMessage): Promise<void> {
        sent.push(message);
      },
    },
  };

  const request = await createSignedWebhookRequest(
    {
      action: 'created',
      sender: { login: 'enyst', id: 1 },
      comment: { body: '@smolpaws test the webhook path', id: 42 },
      repository: {
        full_name: 'enyst/.openhands',
        owner: { login: 'enyst' },
      },
      issue: { number: 4 },
      installation: { id: 99 },
    },
    env.GITHUB_WEBHOOK_SECRET,
  );

  const response = await worker.fetch?.(request, env as never);

  assert(response);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'ALLOWED_ACTORS not configured');
  assert.equal(sent.length, 0);
});

test('webhook mentions fail closed when ALLOWED_ACTORS is empty', async () => {
  const sent: SmolpawsQueueMessage[] = [];
  const env: TestEnv = {
    GITHUB_WEBHOOK_SECRET: 'secret',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'pem',
    ALLOWED_ACTORS: '',
    SMOLPAWS_QUEUE: {
      async send(message: SmolpawsQueueMessage): Promise<void> {
        sent.push(message);
      },
    },
  };

  const request = await createSignedWebhookRequest(
    {
      action: 'created',
      sender: { login: 'enyst', id: 1 },
      comment: { body: '@smolpaws test the webhook path', id: 42 },
      repository: {
        full_name: 'enyst/.openhands',
        owner: { login: 'enyst' },
      },
      issue: { number: 4 },
      installation: { id: 99 },
    },
    env.GITHUB_WEBHOOK_SECRET,
  );

  const response = await worker.fetch?.(request, env as never);

  assert(response);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'ALLOWED_ACTORS not configured');
  assert.equal(sent.length, 0);
});

test('scheduled notifications still queue comment mentions from latest_comment_url', async () => {
  const commentUrl = 'https://api.github.com/repos/enyst/OpenHands-Tab/issues/comments/55';
  const { sent, fetchCalls } = await runScheduled({
    notifications: [
      {
        id: 'thread-2',
        reason: 'mention',
        subject: {
          url: 'https://api.github.com/repos/enyst/OpenHands-Tab/issues/321',
          latest_comment_url: commentUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/OpenHands-Tab',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [commentUrl]: {
        body: {
          id: 55,
          body: '@smolpaws inspect this comment',
          user: { login: 'enyst', id: 8 },
          issue_url: 'https://api.github.com/repos/enyst/OpenHands-Tab/issues/321',
        },
      },
      'https://api.github.com/notifications/threads/thread-2': {
        body: {},
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    event: 'issue_comment',
    payload: {
      action: 'created',
      sender: { login: 'enyst', id: 8 },
      comment: {
        body: '@smolpaws inspect this comment',
        id: 55,
      },
      repository: {
        full_name: 'enyst/OpenHands-Tab',
        owner: { login: 'enyst' },
      },
      issue: {
        number: 321,
      },
    },
    meta: {
      ingress: 'github_notifications',
      notification_thread_id: 'thread-2',
    },
  });
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.url === 'https://api.github.com/notifications/threads/thread-2' &&
        call.method === 'PATCH',
    ),
  );
});

test('scheduled notifications queue pull request review-comment mentions with pull_request context', async () => {
  const commentUrl =
    'https://api.github.com/repos/enyst/OpenHands-Tab/pulls/comments/99';
  const { sent } = await runScheduled({
    notifications: [
      {
        id: 'thread-3',
        reason: 'mention',
        subject: {
          url: 'https://api.github.com/repos/enyst/OpenHands-Tab/pulls/456',
          latest_comment_url: commentUrl,
          type: 'PullRequest',
        },
        repository: {
          full_name: 'enyst/OpenHands-Tab',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [commentUrl]: {
        body: {
          id: 99,
          body: '@smolpaws review this PR comment',
          user: { login: 'enyst', id: 9 },
          pull_request_url: 'https://api.github.com/repos/enyst/OpenHands-Tab/pulls/456',
        },
      },
      'https://api.github.com/notifications/threads/thread-3': {
        body: {},
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    event: 'pull_request_review_comment',
    payload: {
      action: 'created',
      sender: { login: 'enyst', id: 9 },
      comment: {
        body: '@smolpaws review this PR comment',
        id: 99,
      },
      repository: {
        full_name: 'enyst/OpenHands-Tab',
        owner: { login: 'enyst' },
      },
      issue: {
        number: 456,
      },
      pull_request: {
        number: 456,
      },
    },
    meta: {
      ingress: 'github_notifications',
      notification_thread_id: 'thread-3',
    },
  });
});

test('scheduled notifications re-enqueue new mentions on the same thread when latest_comment_url changes', async () => {
  const cache = createMockCache();
  const firstCommentUrl =
    'https://api.github.com/repos/enyst/.openhands/issues/comments/100';
  const secondCommentUrl =
    'https://api.github.com/repos/enyst/.openhands/issues/comments/101';
  const threadUrl = 'https://api.github.com/repos/enyst/.openhands/issues/4';

  const firstRun = await runScheduled({
    cache,
    notifications: [
      {
        id: 'thread-4',
        reason: 'mention',
        subject: {
          url: threadUrl,
          latest_comment_url: firstCommentUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/.openhands',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [firstCommentUrl]: {
        body: {
          id: 100,
          body: '@smolpaws first ping',
          user: { login: 'enyst', id: 8 },
          issue_url: threadUrl,
        },
      },
      'https://api.github.com/notifications/threads/thread-4': {
        body: {},
      },
    },
  });

  const secondRun = await runScheduled({
    cache,
    notifications: [
      {
        id: 'thread-4',
        reason: 'mention',
        subject: {
          url: threadUrl,
          latest_comment_url: secondCommentUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/.openhands',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [secondCommentUrl]: {
        body: {
          id: 101,
          body: '@smolpaws second ping',
          user: { login: 'enyst', id: 8 },
          issue_url: threadUrl,
        },
      },
      'https://api.github.com/notifications/threads/thread-4': {
        body: {},
      },
    },
  });

  assert.deepEqual(firstRun.sent.map((message) => message.payload.comment?.id), [100]);
  assert.deepEqual(secondRun.sent.map((message) => message.payload.comment?.id), [101]);
});

test('scheduled notifications fail closed when ALLOWED_ACTORS is missing', async () => {
  const threadUrl = 'https://api.github.com/repos/enyst/.openhands/issues/9';
  const { sent, fetchCalls } = await runScheduled({
    notifications: [
      {
        id: 'thread-5',
        reason: 'mention',
        subject: {
          url: threadUrl,
          type: 'Issue',
        },
        repository: {
          full_name: 'enyst/.openhands',
          owner: { login: 'enyst' },
        },
      },
    ],
    responses: {
      [threadUrl]: {
        body: {
          number: 9,
          body: '@smolpaws test the notifications path',
          user: { login: 'enyst', id: 7 },
          url: threadUrl,
          repository_url: 'https://api.github.com/repos/enyst/.openhands',
        },
      },
    },
    env: {
      ALLOWED_ACTORS: undefined,
    },
  });

  assert.equal(sent.length, 0);
  assert.deepEqual(fetchCalls, []);
});

test('scheduled notifications fail closed when ALLOWED_ACTORS is empty', async () => {
  const { sent, fetchCalls } = await runScheduled({
    notifications: [],
    responses: {},
    env: {
      ALLOWED_ACTORS: '',
    },
  });

  assert.equal(sent.length, 0);
  assert.deepEqual(fetchCalls, []);
});
