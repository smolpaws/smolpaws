import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AgentServerDeps } from './dependencies.js';
import type { RunnerEnv } from '../runner/workspacePolicy.js';

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

async function startFakeLlmServer(responseText = 'meow from fake llm'): Promise<FakeLlmServer> {
  const requests: OpenAiRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const body = await collectRequestBody(req);
    requests.push(JSON.parse(body) as OpenAiRequest);
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
  return { app, fixture };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
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
    assert.equal(fakeLlm.requests.length, 1);

    const llmRequest = fakeLlm.requests[0]!;
    const systemPrompt = getSystemPrompt(llmRequest);
    const toolNames = getToolNames(llmRequest);

    assert.equal(llmRequest.model, 'gpt-5');
    assert.equal(llmRequest.stream, true);
    assert.deepEqual(llmRequest.messages.at(-1), {
      role: 'user',
      content: 'please inspect repo-a',
    });

    assert.match(systemPrompt, /<REPO_CONTEXT>/);
    assert.match(systemPrompt, /<SKILLS>/);
    assert.match(systemPrompt, /<environment information>/);
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
    assert.match(systemPrompt, /Repo A Guidance/);
    assert.match(systemPrompt, /Always inspect repo-a fixtures before changing code\./);
    assert.match(systemPrompt, /<name>demo-skill<\/name>/);
    assert.match(systemPrompt, /<name>user-guidance<\/name>/);

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
    assert.equal(fakeLlm.requests.length, 1);

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
    assert.equal(fakeLlm.requests.length, 1);

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

test.after(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  if (sharedFixture) {
    rmSync(sharedFixture.homeDir, { recursive: true, force: true });
  }
});
