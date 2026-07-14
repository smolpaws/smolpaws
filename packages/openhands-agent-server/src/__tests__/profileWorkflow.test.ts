import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySecretStore, TestLLM, llmProfileSchema, messageSchema, type LLMProfile, type Message } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentServerHttpClient } from '../../examples/httpClient.js';
import { runProfileWorkflowScenario } from '../../examples/profileWorkflowScenario.js';
import { createReadmeWorkspace } from '../../examples/workspaceFixture.js';
import { createAgentServerApp, type AgentServerApp } from '../app.js';

const sessionApiKey = 'profile-workflow-test';
let root: string | null = null;
let server: AgentServerApp | null = null;

afterEach(async () => {
  await server?.app.close().catch(() => undefined);
  server = null;
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('profile-driven workflow example', () => {
  test('runs two JSON-backed profiles without live credentials', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'openhands-profile-workflow-test-'));
    const conversationsPath = path.join(root, 'conversations');
    const workspaceRoot = path.join(root, 'workspaces');
    const statePath = path.join(root, 'state');
    const sourceReadme = fileURLToPath(new URL('../../README.md', import.meta.url));
    const profiles = await loadProfiles();
    const selectedProfiles: string[] = [];
    const [firstWorkspace, secondWorkspace] = await Promise.all([
      createReadmeWorkspace(workspaceRoot, 'nano-readme-task', sourceReadme),
      createReadmeWorkspace(workspaceRoot, 'mini-readme-task', sourceReadme),
    ]);

    server = await createAgentServerApp({
      secretStore: new InMemorySecretStore(),
      llmClientFactory: async (profile) => {
        selectedProfiles.push(profile.profileId);
        return TestLLM.fromMessages(profile.profileId === 'gpt-nano' ? nanoMessages() : miniMessages());
      },
      config: {
        conversationsPath,
        workspaceRoot,
        statePath,
        allowedFileRoots: [workspaceRoot],
        sessionApiKey,
      },
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });

    const result = await runProfileWorkflowScenario({
      client: new AgentServerHttpClient(localHost(server.app.server.address()), sessionApiKey),
      profiles,
      apiKey: 'test-openai-profile-key',
      conversationsPath,
      firstWorkspace,
      secondWorkspace,
    });

    expect(selectedProfiles).toEqual(['gpt-nano', 'gpt-mini']);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]?.profile).toBe('gpt-nano');
    expect(result.conversations[1]?.profile).toBe('gpt-mini');
    expect(result.first_readme_changed).toBe(true);
    expect(result.second_readme_unchanged).toBe(true);
    expect(result.git_head_unchanged).toBe(true);
    expect(result.independent_conversation_directories).toBe(true);
  }, 20_000);
});

async function loadProfiles(): Promise<readonly [LLMProfile, LLMProfile]> {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL('../../examples/llm-profiles.json', import.meta.url)), 'utf8')) as { readonly profiles?: unknown };
  if (!Array.isArray(raw.profiles) || raw.profiles.length !== 2) throw new Error('expected two profile fixtures');
  return [llmProfileSchema.parse(raw.profiles[0]), llmProfileSchema.parse(raw.profiles[1])];
}

function nanoMessages(): readonly Message[] {
  return [
    finishMessage('nano-summary', '@smolpaws/openhands-agent-server provides an idiomatic TypeScript OpenHands agent-server with REST, WebSocket, persistence, profiles, settings, and OpenAPI support.'),
    toolMessage('nano-edit', 'terminal', { command: "printf '%s\\n' '# OpenHands Agent Server' '' '@smolpaws/openhands-agent-server provides the TypeScript OpenHands REST and WebSocket server with durable conversations, profile-backed agents, settings, and OpenAPI support.' > README.md && git status --short" }),
    finishMessage('nano-edited', 'README_EDITED'),
  ];
}

function miniMessages(): readonly Message[] {
  return [finishMessage('mini-summary', '@smolpaws/openhands-agent-server is the TypeScript server sibling that exposes OpenHands conversation, event, workspace, profile, and OpenAPI surfaces.')];
}

function finishMessage(id: string, message: string): Message {
  return toolMessage(id, 'finish', { message });
}

function toolMessage(id: string, name: string, args: Record<string, unknown>): Message {
  return messageSchema.parse({
    role: 'assistant',
    content: [],
    tool_calls: [{ id, responses_item_id: null, name, arguments: JSON.stringify(args), origin: 'completion' }],
  });
}

function localHost(address: string | AddressInfo | null): string {
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}
