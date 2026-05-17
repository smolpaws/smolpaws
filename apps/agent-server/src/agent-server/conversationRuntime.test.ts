import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentServerDeps } from './dependencies.js';
import type { RunnerEnv } from '../runner/workspacePolicy.js';
import {
  findMessageByIdempotencyKey,
  writePersistedTurnState,
  type ConversationTurnState,
} from '../runner/turnState.js';

type OpenAiRequest = {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

type FakeLlmServer = {
  baseUrl: string;
  requests: OpenAiRequest[];
  close: () => Promise<void>;
};

type TestFixture = {
  homeDir: string;
  reposRoot: string;
  defaultRepoRoot: string;
  targetRepoRoot: string;
  vscodeSettingsPath: string;
};

type AgentServerModules = {
  createAgentServerApp: (deps?: AgentServerDeps) => Promise<{
    app: FastifyInstance;
    deps: AgentServerDeps;
  }>;
  createAgentServerDeps: (env?: RunnerEnv) => AgentServerDeps;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let sharedFixture: TestFixture | undefined;
let loadedModulesPromise: Promise<AgentServerModules> | undefined;
let saveProfilePromise:
  | Promise<typeof import('@smolpaws/agent-sdk')['saveProfile']>
  | undefined;

function ensureSharedFixture(): TestFixture {
  if (sharedFixture) {
    return sharedFixture;
  }

  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-agent-server-home-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const reposRoot = path.join(homeDir, 'repos');
  const defaultRepoRoot = path.join(reposRoot, 'smolpaws');
  const targetRepoRoot = path.join(reposRoot, 'repo-a');
  const vscodeSettingsPath = process.platform === 'darwin'
    ? path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    : process.platform === 'win32'
      ? path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'settings.json')
      : path.join(homeDir, '.config', 'Code', 'User', 'settings.json');

  mkdirSync(reposRoot, { recursive: true });
  mkdirSync(path.join(defaultRepoRoot, '.git'), { recursive: true });
  mkdirSync(path.join(targetRepoRoot, '.git'), { recursive: true });
  mkdirSync(path.join(targetRepoRoot, '.agents', 'skills', 'demo-skill'), {
    recursive: true,
  });
  mkdirSync(path.join(defaultRepoRoot, 'docs', 'smolpaws'), {
    recursive: true,
  });
  mkdirSync(path.join(homeDir, '.openhands', 'skills', 'user-guidance'), {
    recursive: true,
  });
  mkdirSync(path.dirname(vscodeSettingsPath), { recursive: true });

  writeFileSync(
    path.join(defaultRepoRoot, 'AGENTS.md'),
    '# SmolPaws Default Repo\nThis is the canonical local SmolPaws checkout.\n',
  );
  writeFileSync(
    path.join(targetRepoRoot, 'AGENTS.md'),
    '# Repo A Guidance\nAlways inspect repo-a fixtures before changing code.\n',
  );
  writeFileSync(
    path.join(targetRepoRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: Demo project skill for runtime tests',
      '---',
      '# Demo skill',
      'Use this skill when exploring repo-a test fixtures.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'AGENTS.md'),
    '# SmolPaws Workspace\nThis repository is SmolPaws home den.\n',
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'README.md'),
    '# SmolPaws Context Files\nUse this directory to remember who you are.\n',
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'IDENTITY.md'),
    '# IDENTITY.md - Who SmolPaws Is\n- **Name:** `smolpaws`\n- **Creature:** tiny cat agent based on OpenHands\n',
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'MEMORY.md'),
    '# MEMORY.md\n- Stable memory lives here.\n',
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'USER.md'),
    '# USER.md - About Your Human\n- **Name:** Engel Nyst\n- **What to call them:** Engel\n',
  );
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'TOOLS.md'),
    '# TOOLS.md - Local Notes\n- Main repos root: ~/repos\n- Conversation logs: ~/.openhands/conversations\n',
  );
  mkdirSync(path.join(defaultRepoRoot, 'docs', 'smolpaws', 'memory'), {
    recursive: true,
  });
  writeFileSync(
    path.join(defaultRepoRoot, 'docs', 'smolpaws', 'memory', '2026-03-24.md'),
    '# 2026-03-24\n- Daily note.\n',
  );
  writeFileSync(
    path.join(homeDir, '.openhands', 'skills', 'user-guidance', 'SKILL.md'),
    [
      '---',
      'name: user-guidance',
      'description: User-level runtime guidance',
      '---',
      '# User guidance',
      'Prefer concise feline replies when appropriate.',
      '',
    ].join('\n'),
  );

  sharedFixture = {
    homeDir,
    reposRoot,
    defaultRepoRoot,
    targetRepoRoot,
    vscodeSettingsPath,
  };
  return sharedFixture;
}

function writeVscodeProfileSelection(fixture: TestFixture, profileId: string): void {
  writeFileSync(
    fixture.vscodeSettingsPath,
    `${JSON.stringify({ 'openhands.llm.profileId': profileId }, null, 2)}\n`,
  );
}

async function saveDefaultProfile(profileId: string, baseUrl: string, model = 'gpt-5'): Promise<void> {
  if (!saveProfilePromise) {
    saveProfilePromise = import('@smolpaws/agent-sdk').then((module) => module.saveProfile);
  }
  const saveProfile = await saveProfilePromise;
  saveProfile(profileId, {
    provider: 'openai',
    model,
    baseUrl,
  });
}

async function loadAgentServerModules(): Promise<AgentServerModules> {
  ensureSharedFixture();
  if (!loadedModulesPromise) {
    loadedModulesPromise = Promise.all([
      import('./app.js'),
      import('./dependencies.js'),
    ]).then(([appModule, depsModule]): AgentServerModules => ({
      createAgentServerApp: appModule.createAgentServerApp,
      createAgentServerDeps: depsModule.createAgentServerDeps,
    }));
  }
  return loadedModulesPromise!;
}

function collectRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeStreamResponse(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFakeLlmServer(
  responseText = 'meow from fake llm',
  options?: { delayMs?: number },
): Promise<FakeLlmServer> {
  const requests: OpenAiRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const body = await collectRequestBody(req);
    requests.push(JSON.parse(body) as OpenAiRequest);
    if (options?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    writeStreamResponse(res, responseText);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fake LLM server failed to bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createTestApp(fakeLlmBaseUrl: string) {
  const fixture = ensureSharedFixture();
  const { createAgentServerApp, createAgentServerDeps } = await loadAgentServerModules();
  const persistenceDir = path.join(fixture.homeDir, '.openhands', uniqueName('conversations'));
  const deps = createAgentServerDeps({
    SMOLPAWS_WORKSPACE_ROOT: fixture.reposRoot,
    SMOLPAWS_DEFAULT_WORKING_DIR: 'smolpaws',
      SMOLPAWS_PERSISTENCE_DIR: persistenceDir,
  });
  const { app } = await createAgentServerApp(deps);
  return { app, fixture, deps };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function waitForRequestCount(
  fakeLlm: FakeLlmServer,
  expectedCount: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fakeLlm.requests.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fakeLlm.requests.length, expectedCount);
}

function getSystemPrompt(request: OpenAiRequest): string {
  const systemMessage = request.messages[0];
  assert.equal(systemMessage?.role, 'system');
  assert.equal(typeof systemMessage?.content, 'string');
  return systemMessage.content as string;
}

function getToolNames(request: OpenAiRequest): string[] {
  return (request.tools ?? [])
    .map((tool) => tool.function?.name ?? '')
    .filter(Boolean)
    .sort();
}

function buildCreateConversationBody(params: {
  initialMessage: string;
  run?: boolean;
  tools?: Array<{ name: string }>;
  enableSendMessage?: boolean;
  profileId?: string;
  conversationId?: string;
}) {
  return {
    agent: {
      llm: params.profileId ? { profile_id: params.profileId } : {},
      ...(params.tools ? { tools: params.tools } : {}),
    },
    secrets: {
      OPENAI_API_KEY: 'test-api-key',
    },
    max_iterations: 1,
    initial_message: {
      role: 'user',
      content: [{ type: 'text', text: params.initialMessage }],
      ...(params.run === false ? { run: false } : {}),
    },
    ...(params.conversationId ? { conversation_id: params.conversationId } : {}),
    smolpaws: {
      enable_send_message: params.enableSendMessage ?? false,
      github: {
        repository_full_name: 'owner/repo-a',
        actor_login: 'enyst',
        event: 'issue_comment',
        issue_number: 20,
      },
    },
  };
}

function getUserMessageTexts(
  events: Array<{
    kind?: string;
    source?: string;
    llm_message?: {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  }>,
): string[] {
  return events
    .filter(
      (event) => event.kind === 'MessageEvent' && event.source === 'user' && event.llm_message?.role === 'user',
    )
    .map((event) =>
      (event.llm_message?.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() ?? '')
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean);
}

test('POST /api/conversations sends repo skills, user skills, tools, and environment info on the first LLM request', async () => {
  const fakeLlm = await startFakeLlmServer('hello from the first request');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        initialMessage: 'please inspect repo-a',
        enableSendMessage: true,
      }),
    });

    assert.equal(response.statusCode, 201);
    await waitForRequestCount(fakeLlm, 1);

    const llmRequest = fakeLlm.requests[0]!;
    const systemPrompt = getSystemPrompt(llmRequest);
    const toolNames = getToolNames(llmRequest);

    assert.equal(llmRequest.model, 'gpt-5');
    assert.equal(llmRequest.stream, true);
    assert.deepEqual(llmRequest.messages.at(-1), {
      role: 'user',
      content: 'please inspect repo-a',
    });

    assert.match(systemPrompt, /^You are smolpaws, the tiny cat agent based on OpenHands\./);
    assert.doesNotMatch(systemPrompt, /^You are OpenHands agent/);
    assert.match(systemPrompt, /<REPO_CONTEXT>/);
    assert.match(systemPrompt, /<SKILLS>/);
    assert.match(systemPrompt, /<environment information>/);
    assert.match(systemPrompt, /<smolpaws_identity>/);
    assert.match(
      systemPrompt,
      new RegExp(`Your canonical self/context docs live in: ${path.join(fixture.defaultRepoRoot, 'docs', 'smolpaws').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      systemPrompt,
      new RegExp(`Repositories on this machine are typically cloned under: ${fixture.reposRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      systemPrompt,
      new RegExp(`The canonical SmolPaws repository on this machine is: ${fixture.defaultRepoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(systemPrompt, /Default conversation working_dir within that root: smolpaws/);
    assert.match(
      systemPrompt,
      new RegExp(`Current resolved working directory for this conversation: ${fixture.targetRepoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      systemPrompt,
      new RegExp(`Project\\/repo skills for this conversation are loaded from: ${fixture.targetRepoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(systemPrompt, /GitHub repository: owner\/repo-a/);
    assert.match(systemPrompt, /GitHub thread: issue #20/);
    assert.match(systemPrompt, /GitHub actor: enyst/);
    assert.match(
      systemPrompt,
      /local clones under ~\/repos may be stale or detached\. Fetch the relevant remote refs before treating local main\/upstream branches as authoritative\./,
    );
    assert.match(systemPrompt, /Repo A Guidance/);
    assert.match(systemPrompt, /Always inspect repo-a fixtures before changing code\./);
    assert.match(systemPrompt, /This repository is SmolPaws home den\./);
    assert.match(systemPrompt, /\*\*Name:\*\* `smolpaws`/);
    assert.match(systemPrompt, /\*\*What to call them:\*\* Engel/);
    assert.match(systemPrompt, /Stable memory lives here\./);
    assert.match(systemPrompt, /Conversation logs: ~\/\.openhands\/conversations/);
    assert.doesNotMatch(systemPrompt, /Daily note\./);
    assert.match(systemPrompt, /<name>demo-skill<\/name>/);

    assert.deepEqual(toolNames, [
      'file_editor',
      'finish',
      'send_message',
      'task_tracker',
      'terminal',
      'think',
    ]);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('requested remote tools shape the exposed tool set without reintroducing unwanted defaults', async () => {
  const fakeLlm = await startFakeLlmServer('tool profile response');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        initialMessage: 'check the available tools',
        tools: [{ name: 'terminal' }, { name: 'browser' }],
        enableSendMessage: false,
      }),
    });

    assert.equal(response.statusCode, 201);
    await waitForRequestCount(fakeLlm, 1);

    const toolNames = getToolNames(fakeLlm.requests[0]!);
    assert.deepEqual(toolNames, ['browser', 'finish', 'terminal', 'think']);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('queued idle runs stay on the canonical conversation path and only hit the LLM when /run is called', async () => {
  const fakeLlm = await startFakeLlmServer('queued meow');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        initialMessage: 'wait before running',
        run: false,
        enableSendMessage: true,
      }),
    });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(fakeLlm.requests.length, 0);

    const createdConversation = parseJson<{ id: string }>(createResponse.body);
    const runResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${createdConversation.id}/run`,
    });

    assert.equal(runResponse.statusCode, 200);
    assert.deepEqual(parseJson<{ success: boolean }>(runResponse.body), {
      success: true,
    });
    await waitForRequestCount(fakeLlm, 1);

    let assistantEvent:
      | {
          kind: string;
          llm_message?: {
            role: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        }
      | undefined;

    const deadline = Date.now() + 2000;
    while (!assistantEvent && Date.now() < deadline) {
      const eventsResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${createdConversation.id}/events/search?kind=MessageEvent&source=agent&sort_order=timestamp_desc&limit=20`,
      });

      assert.equal(eventsResponse.statusCode, 200);
      const events = parseJson<{
        items: Array<{
          kind: string;
          llm_message?: {
            role: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        }>;
      }>(eventsResponse.body);
      assistantEvent = events.items.find(
        (event) => event.kind === 'MessageEvent' && event.llm_message?.role === 'assistant',
      );
      if (!assistantEvent) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    assert(assistantEvent);
    assert.equal(
      assistantEvent.llm_message?.content?.[0]?.text,
      'queued meow',
    );
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('legacy POST /events waits for turn completion before returning when run is enabled', async () => {
  const fakeLlm = await startFakeLlmServer('legacy endpoint reply', { delayMs: 100 });
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {
        agent: { llm: {} },
        secrets: { OPENAI_API_KEY: 'test-api-key' },
        max_iterations: 1,
      },
    });

    assert.equal(createResponse.statusCode, 201);
    const createdConversation = parseJson<{ id: string }>(createResponse.body);

    const startedAt = Date.now();
    const eventResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${createdConversation.id}/events`,
      payload: {
        role: 'user',
        content: [{ type: 'text', text: 'wait for the assistant before returning' }],
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(eventResponse.statusCode, 200);
    assert.deepEqual(parseJson<{ success: boolean }>(eventResponse.body), {
      success: true,
    });
    assert.ok(
      elapsedMs >= 90,
      `expected legacy events POST to block on execution, got ${elapsedMs}ms`,
    );
    assert.equal(fakeLlm.requests.length, 1);

    const eventsResponse = await app.inject({
      method: 'GET',
      url: `/api/conversations/${createdConversation.id}/events/search?kind=MessageEvent&source=agent&sort_order=timestamp_desc&limit=20`,
    });

    assert.equal(eventsResponse.statusCode, 200);
    const events = parseJson<{
      items: Array<{
        kind: string;
        llm_message?: {
          role: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      }>;
    }>(eventsResponse.body);
    const assistantEvent = events.items.find(
      (event) => event.kind === 'MessageEvent' && event.llm_message?.role === 'assistant',
    );

    assert(assistantEvent);
    assert.equal(assistantEvent.llm_message?.content?.[0]?.text, 'legacy endpoint reply');
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('request llm.profile_id overrides the VS Code-selected default profile', async () => {
  const fakeLlm = await startFakeLlmServer('override profile response');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);
  await saveDefaultProfile('repo-a-profile', fakeLlm.baseUrl, 'gpt-5-mini');

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        initialMessage: 'use the explicit profile',
        enableSendMessage: false,
        profileId: 'repo-a-profile',
      }),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(fakeLlm.requests.length, 1);
    assert.equal(fakeLlm.requests[0]?.model, 'gpt-5-mini');
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('heartbeat ingress adds heartbeat-specific environment context', async () => {
  const fakeLlm = await startFakeLlmServer('heartbeat meow');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {
        agent: { llm: {} },
        secrets: {
          OPENAI_API_KEY: 'test-api-key',
        },
        max_iterations: 1,
        conversation_id: 'heartbeat-smolpaws-2026-03-24',
        initial_message: {
          role: 'user',
          content: [{ type: 'text', text: 'heartbeat turn' }],
        },
        smolpaws: {
          ingress: 'heartbeat',
          enable_send_message: false,
          enable_task_tools: false,
        },
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(fakeLlm.requests.length, 1);
    assert.match(
      getSystemPrompt(fakeLlm.requests[0]!),
      /This run was triggered by the local heartbeat ingress\./,
    );
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('POST /api/conversations resets a reused smolpaws conversation stuck waiting for confirmation', async () => {
  const fakeLlm = await startFakeLlmServer('stale confirmation recovery');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        conversationId: 'stale-confirmation',
        initialMessage: 'first message',
        run: false,
      }),
    });
    assert.equal(createResponse.statusCode, 201);

    const record = deps.conversationRuntime.conversations.get('stale-confirmation');
    assert(record);
    const staleConversation = record.conversation;
    record.events.push({
      kind: 'ConversationStateUpdateEvent',
      source: 'agent',
      agent_status: 'WAITING_FOR_CONFIRMATION',
      id: 'pause-1',
      timestamp: new Date().toISOString(),
    } as never);

    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        conversationId: 'stale-confirmation',
        initialMessage: 'fresh retry',
        run: false,
      }),
    });
    assert.equal(retryResponse.statusCode, 201);

    const nextRecord = deps.conversationRuntime.conversations.get('stale-confirmation');
    assert(nextRecord);
    assert.notEqual(nextRecord.conversation, staleConversation);
    assert.equal(
      nextRecord.events.some(
        (event) =>
          event.kind === 'ConversationStateUpdateEvent' &&
          event.source === 'agent' &&
          event.agent_status === 'WAITING_FOR_CONFIRMATION',
      ),
      false,
    );
    assert.deepEqual(getUserMessageTexts(nextRecord.events), ['fresh retry']);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('POST /api/conversations resets a reused smolpaws conversation exhausted by max iterations', async () => {
  const fakeLlm = await startFakeLlmServer('stale max-iterations recovery');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        conversationId: 'stale-max-iterations',
        initialMessage: 'first message',
        run: false,
      }),
    });
    assert.equal(createResponse.statusCode, 201);

    const record = deps.conversationRuntime.conversations.get('stale-max-iterations');
    assert(record);
    const staleConversation = record.conversation;
    record.events.push({
      kind: 'ConversationErrorEvent',
      source: 'agent',
      code: 'max_iterations_exceeded',
      detail: 'too many iterations',
      id: 'error-1',
      timestamp: new Date().toISOString(),
    } as never);

    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        conversationId: 'stale-max-iterations',
        initialMessage: 'fresh retry',
        run: false,
      }),
    });
    assert.equal(retryResponse.statusCode, 201);

    const nextRecord = deps.conversationRuntime.conversations.get('stale-max-iterations');
    assert(nextRecord);
    assert.notEqual(nextRecord.conversation, staleConversation);
    assert.equal(
      nextRecord.events.some(
        (event) => event.kind === 'ConversationErrorEvent' && event.code === 'max_iterations_exceeded',
      ),
      false,
    );
    assert.deepEqual(getUserMessageTexts(nextRecord.events), ['fresh retry']);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn submission resets a reused stale smolpaws conversation when create_conversation is provided', async () => {
  const fakeLlm = await startFakeLlmServer('stale turn recovery');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: buildCreateConversationBody({
        conversationId: 'stale-turn-submit',
        initialMessage: 'first message',
        run: false,
      }),
    });
    assert.equal(createResponse.statusCode, 201);

    const record = deps.conversationRuntime.conversations.get('stale-turn-submit');
    assert(record);
    const staleConversation = record.conversation;
    record.events.push({
      kind: 'ConversationStateUpdateEvent',
      source: 'agent',
      agent_status: 'WAITING_FOR_CONFIRMATION',
      id: 'pause-turn-1',
      timestamp: new Date().toISOString(),
    } as never);

    const retryResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations/stale-turn-submit/turns',
      payload: {
        idempotency_key: 'fresh-turn-submit',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'fresh retry through turns' }],
          run: false,
        },
        create_conversation: {
          agent: { llm: {} },
          secrets: { OPENAI_API_KEY: 'test-api-key' },
          max_iterations: 1,
          smolpaws: {
            enable_send_message: true,
            github: {
              repository_full_name: 'owner/repo-a',
              actor_login: 'enyst',
              event: 'issue_comment',
              issue_number: 20,
            },
          },
        },
      },
    });
    assert.equal(retryResponse.statusCode, 201);

    const nextRecord = deps.conversationRuntime.conversations.get('stale-turn-submit');
    assert(nextRecord);
    assert.notEqual(nextRecord.conversation, staleConversation);
    assert.equal(
      nextRecord.events.some(
        (event) =>
          event.kind === 'ConversationStateUpdateEvent' &&
          event.source === 'agent' &&
          event.agent_status === 'WAITING_FOR_CONFIRMATION',
      ),
      false,
    );
    assert.deepEqual(getUserMessageTexts(nextRecord.events), ['fresh retry through turns']);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn submission reapplies confirmation policy on a reused live conversation', async () => {
  const fakeLlm = await startFakeLlmServer('confirmation policy reapplied');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const { record } = await deps.conversationRuntime.createConversationRecord({
      conversation_id: 'reused-live-confirmation-policy',
      agent: { llm: {} },
      secrets: { OPENAI_API_KEY: 'test-api-key' },
      max_iterations: 1,
    });

    const originalSetConfirmationPolicy =
      record.conversation.setConfirmationPolicy.bind(record.conversation);
    let confirmationPolicyCalls = 0;
    record.conversation.setConfirmationPolicy = async (...args) => {
      confirmationPolicyCalls += 1;
      return await originalSetConfirmationPolicy(...args);
    };

    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${record.id}/turns`,
      payload: {
        idempotency_key: 'reuse-live-confirmation-policy',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'reuse the live conversation' }],
          run: false,
        },
        create_conversation: {
          agent: { llm: {} },
          confirmation_policy: { kind: 'NeverConfirm' },
          secrets: { OPENAI_API_KEY: 'test-api-key' },
          max_iterations: 1,
          smolpaws: {
            enable_send_message: true,
            github: {
              repository_full_name: 'owner/repo-a',
              actor_login: 'enyst',
              event: 'issue_comment',
              issue_number: 21,
            },
          },
        },
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(confirmationPolicyCalls, 1);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn submission reuses the active turn while it is still queued/running', async () => {
  const fakeLlm = await startFakeLlmServer('queued turn result');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const firstSubmit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-queue-test/turns',
      payload: {
        idempotency_key: 'msg-1',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'first queued message' }],
          run: false,
        },
        create_conversation: {
          agent: { llm: {} },
          secrets: { OPENAI_API_KEY: 'test-api-key' },
          max_iterations: 1,
        },
      },
    });
    assert.equal(firstSubmit.statusCode, 201);
    const first = parseJson<{
      conversation_id: string;
      turn_id: string;
      started_new_turn: boolean;
      status: string;
    }>(firstSubmit.body);
    assert.equal(first.started_new_turn, true);
    assert.equal(first.status, 'running');

    const secondSubmit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-queue-test/turns',
      payload: {
        idempotency_key: 'msg-2',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'second queued message' }],
          run: false,
        },
      },
    });
    assert.equal(secondSubmit.statusCode, 200);
    const second = parseJson<{
      conversation_id: string;
      turn_id: string;
      started_new_turn: boolean;
      status: string;
    }>(secondSubmit.body);
    assert.equal(second.conversation_id, 'turn-queue-test');
    assert.equal(second.turn_id, first.turn_id);
    assert.equal(second.started_new_turn, false);
    assert.equal(second.status, 'running');

    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-queue-test/run',
    });
    assert.equal(runResponse.statusCode, 200);
    await deps.conversationRuntime.waitForTurnProcessor('turn-queue-test');

    const turnStatus = await app.inject({
      method: 'GET',
      url: `/api/conversations/turn-queue-test/turns/${first.turn_id}`,
    });
    assert.equal(turnStatus.statusCode, 200);
    assert.equal(parseJson<{ status: string }>(turnStatus.body).status, 'completed');

    const turnResult = await app.inject({
      method: 'GET',
      url: `/api/conversations/turn-queue-test/turns/${first.turn_id}/result`,
    });
    assert.equal(turnResult.statusCode, 200);
    assert.equal(parseJson<{ reply?: string }>(turnResult.body).reply, 'queued turn result');

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/conversations/turn-queue-test/events/search?kind=MessageEvent&source=user',
    });
    assert.equal(eventsResponse.statusCode, 200);
    const events = parseJson<{
      items: Array<{
        llm_message?: { content?: Array<{ type?: string; text?: string }> };
      }>;
    }>(eventsResponse.body);
    const texts = events.items.map((event) =>
      (event.llm_message?.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n'),
    );
    assert.deepEqual(texts, ['first queued message', 'second queued message']);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn result stays empty until the current turn has a materialized start event', async () => {
  const fakeLlm = await startFakeLlmServer('unused for turn result');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const { record } = await deps.conversationRuntime.createConversationRecord({
      conversation_id: 'turn-result-no-start',
      agent: { llm: {} },
      secrets: { OPENAI_API_KEY: 'test-api-key' },
      max_iterations: 1,
    });
    record.events.push({
      kind: 'MessageEvent',
      source: 'agent',
      id: 'assistant-old',
      timestamp: new Date().toISOString(),
      llm_message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'old reply from a previous turn' }],
      },
    } as never);
    deps.conversationRuntime.turnStates.set(record.id, {
      next_sequence: 2,
      turns: [
        {
          id: 'turn-running-no-start',
          sequence: 1,
          status: 'running',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: 'pending-message-1',
              idempotency_key: 'pending-key',
              accepted_at: new Date().toISOString(),
              content: [{ type: 'text', text: 'new message still pending' }],
            },
          ],
        },
      ],
    });

    const result = await deps.conversationRuntime.getTurnResult(
      'turn-result-no-start',
      'turn-running-no-start',
    );
    assert.deepEqual(result, {});

    const response = await app.inject({
      method: 'GET',
      url: '/api/conversations/turn-result-no-start/turns/turn-running-no-start/result',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseJson<{ status: string; reply?: string }>(response.body), {
      conversation_id: 'turn-result-no-start',
      turn_id: 'turn-running-no-start',
      status: 'running',
    });
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn submission is idempotent for the same conversation and idempotency key', async () => {
  const fakeLlm = await startFakeLlmServer('idempotent turn result');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const payload = {
      idempotency_key: 'same-key',
      user_message: {
        role: 'user',
        content: [{ type: 'text', text: 'same request' }],
        run: false,
      },
      create_conversation: {
        agent: { llm: {} },
        secrets: { OPENAI_API_KEY: 'test-api-key' },
        max_iterations: 1,
      },
    };

    const firstSubmit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-idempotency-test/turns',
      payload,
    });
    const secondSubmit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-idempotency-test/turns',
      payload,
    });

    assert.equal(firstSubmit.statusCode, 201);
    assert.equal(secondSubmit.statusCode, 200);

    const first = parseJson<{
      turn_id: string;
      message_event_id: string;
      started_new_turn: boolean;
    }>(firstSubmit.body);
    const second = parseJson<{
      turn_id: string;
      message_event_id: string;
      started_new_turn: boolean;
    }>(secondSubmit.body);

    assert.equal(first.turn_id, second.turn_id);
    assert.equal(first.message_event_id, second.message_event_id);
    assert.equal(first.started_new_turn, true);
    assert.equal(second.started_new_turn, false);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn submission returns 404 when the conversation is missing and create_conversation is omitted', async () => {
  const { app } = await createTestApp('http://unused.invalid');

  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${uniqueName('missing-turn-submit')}/turns`,
      payload: {
        idempotency_key: 'missing-key',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello from a missing conversation' }],
          run: false,
        },
      },
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(parseJson<{ error: string }>(response.body), {
      error: 'Conversation not found',
    });
  } finally {
    await app.close();
  }
});


test('idempotent turn retries re-kick a persisted running turn even for non-owners', async () => {
  const fakeLlm = await startFakeLlmServer('recovered after retry');
  const { app, fixture, deps } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const { record } = await deps.conversationRuntime.createConversationRecord({
      conversation_id: 'turn-idempotent-retry-test',
      agent: { llm: {} },
      secrets: { OPENAI_API_KEY: 'test-api-key' },
      max_iterations: 1,
    });
    const now = '2026-03-27T00:00:00.000Z';
    const turnState: ConversationTurnState = {
      next_sequence: 2,
      turns: [
        {
          id: 'turn-existing',
          sequence: 1,
          status: 'running' as const,
          started_at: now,
          updated_at: now,
          delivery_owner_id: 'owner-1',
          delivery_owner_claimed_at: now,
          messages: [
            {
              id: 'message-1',
              idempotency_key: 'same-key',
              accepted_at: now,
              content: [{ type: 'text', text: 'retry me' }],
            },
          ],
        },
      ],
    };
    deps.conversationRuntime.turnStates.set(record.id, turnState);
    await writePersistedTurnState(
      record.id,
      deps.conversationRuntime.persistenceRoot,
      turnState,
    );
    assert.equal(
      findMessageByIdempotencyKey(turnState, 'same-key')?.turn.id,
      'turn-existing',
    );

    const retried = await deps.conversationRuntime.submitTurnMessage({
      conversationId: record.id,
      idempotencyKey: 'same-key',
      deliveryOwnerId: 'owner-2',
      userMessage: {
        content: [{ type: 'text', text: 'retry me' }],
        run: true,
      },
    });

    assert.equal(retried.turnId, 'turn-existing');
    assert.equal(retried.messageEventId, 'message-1');
    assert.equal(retried.startedNewTurn, false);
    assert.equal(retried.isDeliveryOwner, false);

    await deps.conversationRuntime.waitForTurnProcessor(record.id);

    const recoveredTurn = await deps.conversationRuntime.getTurnOrThrow(
      record.id,
      'turn-existing',
    );
    assert.equal(recoveredTurn.status, 'completed');

    const result = await deps.conversationRuntime.getTurnResult(
      record.id,
      'turn-existing',
    );
    assert.equal(result.reply, 'recovered after retry');
    await waitForRequestCount(fakeLlm, 1);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn status only reports ownership for the matching caller and keeps owner ids server-side', async () => {
  const fakeLlm = await startFakeLlmServer('owner status result');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const submit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-owner-status-test/turns',
      payload: {
        idempotency_key: 'owner-status-key',
        delivery_owner_id: 'owner-1',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'owner status request' }],
          run: false,
        },
        create_conversation: {
          agent: { llm: {} },
          secrets: { OPENAI_API_KEY: 'test-api-key' },
          max_iterations: 1,
        },
      },
    });
    assert.equal(submit.statusCode, 201);
    const created = parseJson<{ turn_id: string }>(submit.body);

    const anonymousStatus = await app.inject({
      method: 'GET',
      url: `/api/conversations/turn-owner-status-test/turns/${created.turn_id}`,
    });
    assert.equal(anonymousStatus.statusCode, 200);
    const anonymous = parseJson<Record<string, unknown>>(anonymousStatus.body);
    assert.equal(anonymous.is_delivery_owner, false);
    assert.equal('delivery_owner_id' in anonymous, false);

    const ownerStatus = await app.inject({
      method: 'GET',
      url: `/api/conversations/turn-owner-status-test/turns/${created.turn_id}?delivery_owner_id=owner-1`,
    });
    assert.equal(ownerStatus.statusCode, 200);
    assert.equal(parseJson<{ is_delivery_owner: boolean }>(ownerStatus.body).is_delivery_owner, true);

    const otherStatus = await app.inject({
      method: 'GET',
      url: `/api/conversations/turn-owner-status-test/turns/${created.turn_id}?delivery_owner_id=owner-2`,
    });
    assert.equal(otherStatus.statusCode, 200);
    assert.equal(parseJson<{ is_delivery_owner: boolean }>(otherStatus.body).is_delivery_owner, false);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test('turn-scoped claims reject other delivery owners and allow the recorded owner', async () => {
  const fakeLlm = await startFakeLlmServer('owner claim result');
  const { app, fixture } = await createTestApp(fakeLlm.baseUrl);
  writeVscodeProfileSelection(fixture, 'gpt-5');
  await saveDefaultProfile('gpt-5', fakeLlm.baseUrl);

  try {
    const submit = await app.inject({
      method: 'POST',
      url: '/api/conversations/turn-owner-claim-test/turns',
      payload: {
        idempotency_key: 'owner-claim-key',
        delivery_owner_id: 'owner-1',
        user_message: {
          role: 'user',
          content: [{ type: 'text', text: 'owner claim request' }],
          run: false,
        },
        create_conversation: {
          agent: { llm: {} },
          secrets: { OPENAI_API_KEY: 'test-api-key' },
          max_iterations: 1,
        },
      },
    });
    assert.equal(submit.statusCode, 201);
    const created = parseJson<{ turn_id: string }>(submit.body);

    const wrongOwnerOutbound = await app.inject({
      method: 'POST',
      url: `/api/conversations/turn-owner-claim-test/turns/${created.turn_id}/outbound_messages/claim`,
      payload: { delivery_owner_id: 'owner-2' },
    });
    assert.equal(wrongOwnerOutbound.statusCode, 409);

    const rightOwnerOutbound = await app.inject({
      method: 'POST',
      url: `/api/conversations/turn-owner-claim-test/turns/${created.turn_id}/outbound_messages/claim`,
      payload: { delivery_owner_id: 'owner-1' },
    });
    assert.equal(rightOwnerOutbound.statusCode, 200);
    assert.deepEqual(parseJson<unknown[]>(rightOwnerOutbound.body), []);

    const wrongOwnerTasks = await app.inject({
      method: 'POST',
      url: `/api/conversations/turn-owner-claim-test/turns/${created.turn_id}/task_commands/claim`,
      payload: { delivery_owner_id: 'owner-2' },
    });
    assert.equal(wrongOwnerTasks.statusCode, 409);

    const rightOwnerTasks = await app.inject({
      method: 'POST',
      url: `/api/conversations/turn-owner-claim-test/turns/${created.turn_id}/task_commands/claim`,
      payload: { delivery_owner_id: 'owner-1' },
    });
    assert.equal(rightOwnerTasks.statusCode, 200);
    assert.deepEqual(parseJson<unknown[]>(rightOwnerTasks.body), []);
  } finally {
    await app.close();
    await fakeLlm.close();
  }
});

test.after(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  if (sharedFixture) {
    rmSync(sharedFixture.homeDir, { recursive: true, force: true });
  }
});
