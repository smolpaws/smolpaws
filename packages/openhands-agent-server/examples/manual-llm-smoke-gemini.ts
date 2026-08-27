import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySecretStore, llmProfileSchema, type LLMProfile } from '@smolpaws/openhands-agent';

import { createAgentServerApp } from '../src/app.js';
import { AgentServerHttpClient, assert } from './httpClient.js';
import { runProfileWorkflowScenario } from './profileWorkflowScenario.js';
import { createReadmeWorkspace } from './workspaceFixture.js';

const apiKey = requiredEnvironmentValue('GEMINI_API_KEY');

const sessionApiKey = 'gemini-profile-workflow-smoke';
const dummySecretValue = 'profile-workflow-dummy-secret-not-persisted';

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-gemini-profile-workflow-'));
  const conversationsPath = path.join(root, 'conversations');
  const workspaceRoot = path.join(root, 'workspaces');
  const statePath = path.join(root, 'state');
  const sourceReadme = fileURLToPath(new URL('../README.md', import.meta.url));
  const profiles = await loadProfiles();
  const [firstWorkspace, secondWorkspace] = await Promise.all([
    createReadmeWorkspace(workspaceRoot, 'flash-25-readme-task', sourceReadme),
    createReadmeWorkspace(workspaceRoot, 'flash-lite-readme-task', sourceReadme),
  ]);
  const server = await createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    config: {
      conversationsPath,
      workspaceRoot,
      statePath,
      allowedFileRoots: [workspaceRoot],
      sessionApiKey,
    },
  });

  try {
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new AgentServerHttpClient(localHost(server.app.server.address()), sessionApiKey);
    const result = await runProfileWorkflowScenario({
      client,
      profiles,
      apiKey,
      conversationsPath,
      firstWorkspace,
      secondWorkspace,
    });
    assert(!(await pathContains(root, apiKey)), 'GEMINI_API_KEY was persisted in plaintext');
    assert(!(await pathContains(root, dummySecretValue)), 'dummy profile workflow secret was persisted in plaintext');

    console.log(JSON.stringify({
      ok: true,
      one_profile_driven_server: true,
      injected_agent_factory: false,
      remote_conversation_used: false,
      gemini_api_key_plaintext_persisted: false,
      dummy_profile_workflow_secret_plaintext_persisted: false,
      result,
    }, null, 2));
  } finally {
    await server.app.close().catch(() => undefined);
    if (process.env.KEEP_PROFILE_WORKFLOW_ARTIFACTS === '1') {
      console.log(`Gemini profile workflow artifacts retained at ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Set ${name} to run this manual smoke. The server stores it only in an in-memory SecretStore and never prints it.`);
  }
  return value;
}

async function loadProfiles(): Promise<readonly [LLMProfile, LLMProfile]> {
  const file = new URL('./llm-profiles-gemini.json', import.meta.url);
  const raw = JSON.parse(await readFile(file, 'utf8')) as { readonly profiles?: unknown };
  if (!Array.isArray(raw.profiles) || raw.profiles.length !== 2) throw new Error('llm-profiles-gemini.json must contain exactly two profiles.');
  return [llmProfileSchema.parse(raw.profiles[0]), llmProfileSchema.parse(raw.profiles[1])];
}

async function pathContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await pathContains(fullPath, needle)) return true;
    } else if (entry.isFile() && (await stat(fullPath)).size <= 1_000_000) {
      if ((await readFile(fullPath, 'utf8')).includes(needle)) return true;
    }
  }
  return false;
}

function localHost(address: string | AddressInfo | null): string {
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

await main();
