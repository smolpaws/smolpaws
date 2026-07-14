import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Agent, FinishTool, InMemorySecretStore, TestLLM, ToolDefinition, type LLMProfile, type Message } from '@smolpaws/openhands-agent';
import { z } from 'zod';

import { createAgentServerApp } from '../src/app.js';

const execFileAsync = promisify(execFile);
const sessionApiKey = 'local-endpoint-smoke';
const dummySecretValue = 'dummy-oh-secret-local-smoke-value';
const asyncMessageOne = 'async-user-message-one';
const asyncMessageTwo = 'async-user-message-two';
const covered = new Set<string>();

const delayTool = new ToolDefinition({
  name: 'delay',
  description: 'Delay briefly so the local smoke can enqueue a message while a run is active.',
  inputSchema: z.object({ ms: z.number().int().min(1).max(1_000) }).strict(),
  executor: async ({ ms }: { readonly ms: number }) => {
    await sleep(ms);
    return { message: `delayed ${ms}ms` };
  },
});

const llmProfile: LLMProfile = {
  profileId: 'local-endpoint-smoke-profile',
  providerId: 'test',
  model: 'scripted-local-smoke',
  baseUrl: null,
  openAiApiMode: 'responses',
  temperature: null,
  topP: null,
  topK: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  timeoutSeconds: null,
  reasoningEffort: null,
  reasoningSummary: null,
  headers: {},
  useProfileKeyOverride: false,
};

let root = '';
let workspaceRoot = '';
let conversationsPath = '';
let statePath = '';
let bashEventsPath = '';
let secretStore = new InMemorySecretStore();
let server: Awaited<ReturnType<typeof createAgentServerApp>> | null = null;
let host = '';

async function main(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-local-endpoints-'));
  try {
    workspaceRoot = path.join(root, 'workspace');
    conversationsPath = path.join(root, 'conversations');
    statePath = path.join(root, 'state');
    bashEventsPath = path.join(root, 'bash-events');
    await mkdir(workspaceRoot, { recursive: true });

    secretStore = new InMemorySecretStore();
    server = await createAgentServerApp({
      agentFactory: localAgentFactory,
      secretStore,
      config: {
        conversationsPath,
        statePath,
        bashEventsPath,
        workspaceRoot,
        allowedFileRoots: [workspaceRoot],
        sessionApiKey,
      },
    });
    host = await listen(server.app);
    const client = new LocalClient(host);

    await coverServerDetails(client);
    await coverStateProfilesSecrets(client);
    await coverSkills(client);
    await coverFiles(client);
    await coverGit(client);
    await coverBash(client);
    const conversationId = await coverConversationEventsAndRun(client);
    await coverCompatibilityResponses(client, conversationId);
    await coverForkDeleteLeaseAndRestart(client, conversationId);
    await assertNoPlaintextSecretPersisted(root);

    console.log(JSON.stringify({
      ok: true,
      started_server: host,
      covered_operations: [...covered].sort(),
      evidence: {
        async_user_messages_preserved_separately: true,
        oh_secret_plaintext_persisted: false,
        remote_conversation_client_used: false,
      },
      remaining_gaps: [
        'Live provider/model calls are covered by examples/manual-llm-smoke.ts, not this credential-free smoke.',
        'RemoteConversation and RemoteWorkspace parity are intentionally excluded from this task.',
        'Deferred upstream route families remain documented in README/docs: trajectory download, /v1 gateway, VS Code/desktop/auth-cookie/MCP/workspace routers.',
      ],
    }, null, 2));
  } finally {
    await server?.app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function coverServerDetails(client: LocalClient): Promise<void> {
  assertEqual((await client.getJson<{ status: string }>('/alive', false)).status, 'ok', 'alive status');
  assertEqual((await client.getJson<{ status: string }>('/health', false)).status, 'ok', 'health status');
  assertEqual((await client.getJson<{ status: string }>('/ready', false)).status, 'ready', 'ready status');
  const info = await client.getJson<{ status: string; python_version: string; node_version: string; usable_tools: string[] }>('/server_info', false);
  assertEqual(info.status, 'ok', 'server_info status');
  assertEqual(info.python_version, 'not-applicable', 'server_info python_version');
  assertEqual(info.node_version, process.version, 'server_info node_version');
  assert(info.usable_tools.includes('bash'), 'server_info exposes bash tool');
  const openapi = await client.getJson<{ paths: Record<string, unknown> }>('/openapi.json', false);
  assert(openapi.paths['/api/conversations/{conversation_id}/run'] !== undefined, 'OpenAPI includes run route');
  const unauthorized = await client.raw('/api/conversations/count', { auth: false });
  assertEqual(unauthorized.status, 401, 'API auth rejects missing session key');
  assertEqual(await client.getJson<number>('/api/conversations/count'), 0, 'initial conversation count');
  covered.add('health/server-info/openapi/auth');
}

async function coverStateProfilesSecrets(client: LocalClient): Promise<void> {
  const settings = await client.getJson<{ active_profile_id: string | null; llm_api_key_set: boolean }>('/api/settings');
  assertEqual(settings.active_profile_id, 'default', 'default active profile');
  assertEqual(typeof settings.llm_api_key_set, 'boolean', 'llm api key flag shape');
  assert((await client.getJson<{ schema: unknown }>('/api/settings/agent-schema')).schema !== undefined, 'agent settings schema present');
  assert((await client.getJson<{ schema: unknown }>('/api/settings/conversation-schema')).schema !== undefined, 'conversation settings schema present');

  const createdSecret = await client.putJson<{ name: string; value?: string }>('/api/settings/secrets', { name: 'OH_SECRET', value: dummySecretValue });
  assertEqual(createdSecret.name, 'OH_SECRET', 'created OH_SECRET metadata');
  assert(createdSecret.value === undefined, 'secret create response does not expose value');
  const secretList = await client.getJson<{ secrets: Array<{ name: string; value?: string }> }>('/api/settings/secrets');
  assert(secretList.secrets.some((secret) => secret.name === 'OH_SECRET' && secret.value === undefined), 'secret list redacts values');
  const secretMetadata = await client.getJson<{ name: string; value: string }>('/api/settings/secrets/OH_SECRET');
  assertEqual(secretMetadata.value, '**********', 'secret get returns placeholder');

  const profile = await client.postJson<LLMProfile>('/api/profiles', llmProfile, 201);
  assertEqual(profile.profileId, llmProfile.profileId, 'profile created');
  const profiles = await client.getJson<{ profiles: LLMProfile[]; active_profile_id: string | null }>('/api/profiles');
  assert(profiles.profiles.some((item) => item.profileId === llmProfile.profileId), 'profile list includes created profile');
  await client.postJson(`/api/profiles/${llmProfile.profileId}/activate`, {});
  const updatedSettings = await client.patchJson<{ active_profile_id: string | null }>('/api/settings', { active_profile_id: llmProfile.profileId });
  assertEqual(updatedSettings.active_profile_id, llmProfile.profileId, 'settings active profile updated');

  const agentProfile = await client.postJson<{ id: string; name: string; llm_profile_ref: string }>('/api/agent-profiles', { name: 'local-endpoint-agent', llm_profile_ref: llmProfile.profileId }, 201);
  assertEqual(agentProfile.name, 'local-endpoint-agent', 'agent profile created');
  assertEqual(agentProfile.llm_profile_ref, llmProfile.profileId, 'agent profile references llm profile');
  const materialized = await client.postJson<{ valid: boolean; resolved_settings: Record<string, unknown> }>('/api/agent-profiles/local-endpoint-agent/materialize', {});
  assertEqual(materialized.valid, true, 'agent profile materializes');
  assert(!JSON.stringify(materialized).includes(dummySecretValue), 'agent profile materialization does not expose dummy secret');
  await client.postJson(`/api/agent-profiles/${agentProfile.id}/activate`, {});
  const agentProfiles = await client.getJson<{ profiles: Array<{ name: string }>; active_agent_profile_id: string | null }>('/api/agent-profiles');
  assert(agentProfiles.profiles.some((item) => item.name === 'local-endpoint-agent'), 'agent profile list includes created profile');
  assertEqual(agentProfiles.active_agent_profile_id, agentProfile.id, 'active agent profile updated');
  covered.add('settings/profiles/agent-profiles/secrets');
}

async function coverSkills(client: LocalClient): Promise<void> {
  const projectSkill = path.join(workspaceRoot, '.openhands', 'skills', 'demo', 'SKILL.md');
  const localSkill = path.join(root, 'local-skill', 'SKILL.md');
  await mkdir(path.dirname(projectSkill), { recursive: true });
  await mkdir(path.dirname(localSkill), { recursive: true });
  await writeFile(projectSkill, '---\nname: demo\ndescription: Demo project skill\ntriggers:\n  - demo\n---\nUse demo skill.\n', 'utf8');
  await writeFile(localSkill, '---\nname: installed-demo\ndescription: Installed skill\n---\nInstalled content.\n', 'utf8');

  const loaded = await client.postJson<{ skills: Array<{ name: string }>; sources: Record<string, number> }>('/api/skills', { load_user: false, load_project: true, project_dir: workspaceRoot });
  assert(loaded.skills.some((skill) => skill.name === 'demo'), 'project skill is loaded');
  assert((loaded.sources.project ?? 0) >= 1, 'project skill source count is set');
  assertEqual((await client.postJson<{ status: string }>('/api/skills/sync', {})).status, 'success', 'skills sync compatibility response');
  const installed = await client.postJson<{ name: string; enabled: boolean }>('/api/skills/install', { source: path.dirname(localSkill) }, 201);
  assertEqual(installed.name, 'installed-demo', 'local skill installed');
  assertEqual((await client.getJson<{ name: string }>('/api/skills/installed/installed-demo')).name, 'installed-demo', 'installed skill get');
  const disabled = await client.patchJson<{ name: string; enabled: boolean }>('/api/skills/installed/installed-demo', { enabled: false });
  assertEqual(disabled.enabled, false, 'installed skill disabled');
  assert((await client.getJson<{ skills: Array<{ name: string; enabled: boolean }> }>('/api/skills/installed')).skills.some((skill) => skill.name === 'installed-demo' && !skill.enabled), 'installed skill list reflects disabled state');
  assert((await client.postJson<{ message: string }>('/api/skills/installed/installed-demo/refresh', {})).message.includes('updated'), 'installed skill refresh');
  assert(Array.isArray((await client.getJson<{ skills: unknown[] }>('/api/skills/marketplace')).skills), 'marketplace returns list');
  assert((await client.deleteJson<{ message: string }>('/api/skills/installed/installed-demo')).message.includes('uninstalled'), 'installed skill deleted');
  covered.add('skills/load-sync-install-list-get-patch-refresh-marketplace-delete');
}

async function coverFiles(client: LocalClient): Promise<void> {
  const nestedDir = path.join(workspaceRoot, 'files', 'nested');
  await mkdir(nestedDir, { recursive: true });
  const uploadPath = path.join(nestedDir, 'uploaded.txt');
  const form = new FormData();
  form.append('file', new Blob(['uploaded-through-fetch']), 'uploaded.txt');
  const upload = await client.raw(`/api/file/upload?path=${encodeURIComponent(uploadPath)}`, { method: 'POST', body: form });
  assertEqual(upload.status, 200, 'file upload status');
  assertEqual(await readFile(uploadPath, 'utf8'), 'uploaded-through-fetch', 'file upload writes content');
  assertEqual(await client.getText(`/api/file/download?path=${encodeURIComponent(uploadPath)}`), 'uploaded-through-fetch', 'file download returns uploaded content');
  assert((await client.getJson<{ home: string; locations: unknown[] }>('/api/file/home')).home.length > 0, 'file home returns home path');
  const dirs = await client.getJson<{ items: Array<{ name: string; path: string }> }>(`/api/file/search_subdirs?path=${encodeURIComponent(path.join(workspaceRoot, 'files'))}&limit=10`);
  assert(dirs.items.some((item) => item.name === 'nested'), 'file search_subdirs returns nested dir');
  const outsidePath = path.join(root, 'outside.txt');
  await writeFile(outsidePath, 'outside', 'utf8');
  assertEqual((await client.raw(`/api/file/download?path=${encodeURIComponent(outsidePath)}`)).status, 403, 'file download rejects outside root');
  covered.add('file/upload-download-home-search-authorization');
}

async function coverGit(client: LocalClient): Promise<void> {
  const repo = path.join(workspaceRoot, 'repo');
  const tracked = path.join(repo, 'tracked.txt');
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init', '-q']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Local Smoke']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'local-smoke@example.invalid']);
  await writeFile(tracked, 'original\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  await writeFile(tracked, 'modified\n', 'utf8');
  await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');

  const changes = await client.getJson<Array<{ status: string; path: string }>>(`/api/git/changes?path=${encodeURIComponent(repo)}`);
  assert(changes.some((change) => change.status === 'UPDATED' && change.path === 'tracked.txt'), 'git changes include modified tracked file');
  assert(changes.some((change) => change.status === 'ADDED' && change.path === 'untracked.txt'), 'git changes include untracked file');
  const diff = await client.getJson<{ original: string | null; modified: string | null }>(`/api/git/diff?path=${encodeURIComponent(tracked)}`);
  assertEqual(diff.original, 'original\n', 'git diff original content');
  assertEqual(diff.modified, 'modified\n', 'git diff modified content');
  covered.add('git/changes-diff');
}

async function coverBash(client: LocalClient): Promise<void> {
  const executed = await client.postJson<{ id: string; command_id: string; stdout: string | null; exit_code: number | null }>('/api/bash/execute_bash_command', { command: 'printf bash-http-ok', cwd: workspaceRoot, timeout: 5 });
  assertEqual(executed.stdout, 'bash-http-ok', 'bash execute stdout');
  assertEqual(executed.exit_code, 0, 'bash execute exit code');
  const searched = await client.getJson<{ items: Array<{ id: string; kind: string; command_id?: string }> }>(`/api/bash/bash_events/search?kind__eq=BashOutput&command_id__eq=${encodeURIComponent(executed.command_id)}`);
  assert(searched.items.some((item) => item.id === executed.id), 'bash search returns executed output');
  assertEqual((await client.getJson<{ id: string }>(`/api/bash/bash_events/${executed.id}`)).id, executed.id, 'bash get by id');
  assertEqual((await client.getJson<Array<{ id: string } | null>>(`/api/bash/bash_events?event_ids=${encodeURIComponent(executed.id)}`))[0]?.id, executed.id, 'bash batch get');

  const bashSocket = await openSocket(`${host.replace('http:', 'ws:')}/sockets/bash-events?session_api_key=${encodeURIComponent(sessionApiKey)}`);
  try {
    const commandPromise = waitForSocketJson<{ kind: string; id: string }>(bashSocket, (message) => message.kind === 'BashCommand', 'bash command event');
    bashSocket.send(JSON.stringify({ command: 'printf bash-ws-ok', cwd: workspaceRoot, timeout: 5 }));
    const command = await commandPromise;
    const output = await waitForSocketJson<{ kind: string; command_id: string; stdout: string | null }>(bashSocket, (message) => message.kind === 'BashOutput' && message.command_id === command.id, 'bash output event');
    assertEqual(output.stdout, 'bash-ws-ok', 'bash websocket output');
  } finally {
    bashSocket.close();
  }

  const cleared = await client.deleteJson<{ cleared_count: number }>('/api/bash/bash_events');
  assert(cleared.cleared_count >= 2, 'bash clear removes command/output events');
  covered.add('bash/execute-search-get-batch-websocket-clear');
}

async function coverConversationEventsAndRun(client: LocalClient): Promise<string> {
  const conversation = await client.postJson<{ id: string; title: string | null; tags: Record<string, string>; secret_registry: Record<string, unknown> }>('/api/conversations', {
    title: 'Local endpoint smoke',
    tags: { kind: 'local-smoke' },
    secrets: { OH_SECRET: dummySecretValue },
  }, 201);
  assertEqual(conversation.title, 'Local endpoint smoke', 'conversation title set');
  assertEqual(conversation.tags.kind, 'local-smoke', 'conversation tags set');
  assert(conversation.secret_registry.OH_SECRET !== undefined, 'conversation secret registry references OH_SECRET');
  assert(!JSON.stringify(conversation).includes(dummySecretValue), 'conversation create response does not expose OH_SECRET plaintext');

  const id = conversation.id;
  await client.patchJson(`/api/conversations/${id}`, { title: 'Updated local endpoint smoke', tags: { kind: 'local-smoke', updated: 'true' } });
  const fetched = await client.getJson<{ title: string | null; tags: Record<string, string> }>(`/api/conversations/${id}`);
  assertEqual(fetched.title, 'Updated local endpoint smoke', 'conversation update persisted title');
  assertEqual(fetched.tags.updated, 'true', 'conversation update persisted tags');
  assertEqual(await client.getJson<number>('/api/conversations/count'), 1, 'conversation count after create');
  assert((await client.getJson<{ items: Array<{ id: string }> }>('/api/conversations/search?limit=10')).items.some((item) => item.id === id), 'conversation search returns conversation');
  assertEqual((await client.getJson<Array<{ id: string } | null>>(`/api/conversations?ids=${encodeURIComponent(id)}`))[0]?.id, id, 'conversation batch get');

  const socket = await openSocket(`${host.replace('http:', 'ws:')}/sockets/events/${id}`);
  try {
    socket.send(JSON.stringify({ type: 'auth', session_api_key: sessionApiKey }));
    await waitForSocketJson<{ kind: string; key?: string }>(socket, (message) => message.kind === 'ConversationStateUpdateEvent' && message.key === 'full_state', 'conversation initial full_state');
    const firstMessagePromise = waitForSocketJson<{ kind: string; llm_message?: { role: string } }>(socket, (message) => message.kind === 'MessageEvent' && JSON.stringify(message).includes(asyncMessageOne), 'first websocket user event');
    socket.send(JSON.stringify({ role: 'user', content: asyncMessageOne, run: false }));
    const firstMessage = await firstMessagePromise;
    assertEqual(firstMessage.kind, 'MessageEvent', 'websocket accepts inbound user message and emits event');

    const startedAt = performance.now();
    const run = await client.postJson<{ success: boolean }>(`/api/conversations/${id}/run`, {});
    assertEqual(run.success, true, 'run endpoint accepted');
    assert(performance.now() - startedAt < 100, 'run endpoint returns non-blockingly');

    await client.postJson(`/api/conversations/${id}/events`, { role: 'user', content: asyncMessageTwo, run: true });
    await waitFor(async () => {
      const final = await client.getJson<{ response: string }>(`/api/conversations/${id}/agent_final_response`);
      assertEqual(final.response, 'local-smoke-first-run', 'first run completes while second message is preserved');
    }, 5_000);
  } finally {
    socket.close();
  }

  const eventPage = await client.getJson<{ items: EventLike[] }>(`/api/conversations/${id}/events/search?kind=MessageEvent&source=user&limit=10`);
  const userMessages = eventPage.items.map(eventText).filter(Boolean);
  assert(userMessages.includes(asyncMessageOne), 'first async user message is preserved');
  assert(userMessages.includes(asyncMessageTwo), 'second async user message is preserved');
  assertEqual(userMessages.filter((message) => message === asyncMessageOne || message === asyncMessageTwo).length, 2, 'async user messages remain separate events');
  const eventCount = await client.getJson<number>(`/api/conversations/${id}/events/count?kind=MessageEvent&source=user`);
  assert(eventCount >= 2, 'event count reflects separate user messages');
  const firstEventId = eventPage.items[0]?.id;
  assert(firstEventId !== undefined, 'event page includes ids');
  assertEqual((await client.getJson<EventLike>(`/api/conversations/${id}/events/${firstEventId}`)).id, firstEventId, 'event get by id');
  assertEqual((await client.getJson<Array<EventLike | null>>(`/api/conversations/${id}/events?event_ids=${encodeURIComponent(firstEventId)}`))[0]?.id, firstEventId, 'event batch get');
  await client.postJson<{ success: boolean }>(`/api/conversations/${id}/secrets`, { secrets: { OH_SECRET: dummySecretValue } });
  const afterSecretUpdate = await client.getJson<{ secret_registry: Record<string, unknown> }>(`/api/conversations/${id}`);
  assert(afterSecretUpdate.secret_registry.OH_SECRET !== undefined, 'conversation secret update keeps OH_SECRET reference');
  assert(!JSON.stringify(afterSecretUpdate).includes(dummySecretValue), 'conversation secret update response does not expose OH_SECRET plaintext');
  await client.postJson<{ success: boolean }>(`/api/conversations/${id}/pause`, {});
  await client.postJson<{ success: boolean }>(`/api/conversations/${id}/interrupt`, {});
  covered.add('conversations/events/websocket/run-queue/pause-interrupt/secrets');
  return id;
}

async function coverCompatibilityResponses(client: LocalClient, conversationId: string): Promise<void> {
  assertAcceptedDeviation(await client.postJson<AcceptedDeviation>(`/api/conversations/${conversationId}/confirmation_policy`, { policy: { mode: 'never' } }, 410), 'confirmation_policy');
  assertAcceptedDeviation(await client.postJson<AcceptedDeviation>(`/api/conversations/${conversationId}/security_analyzer`, { security_analyzer: null }, 410), 'security_analyzer');
  assertAcceptedDeviation(await client.postJson<AcceptedDeviation>(`/api/conversations/${conversationId}/events/respond_to_confirmation`, { accept: true, reason: 'local smoke' }, 410), 'confirmation_responses');
  assertEqual((await client.postJson<{ detail: string }>(`/api/conversations/${conversationId}/ask_agent`, { question: 'status?' }, 501)).detail, 'ask_agent_not_implemented', 'ask_agent unsupported compatibility response');
  assertEqual((await client.postJson<{ detail: string }>(`/api/conversations/${conversationId}/goal`, { objective: 'local smoke' }, 501)).detail, 'goal_loop_not_implemented', 'goal unsupported compatibility response');
  covered.add('accepted-deviation-and-unsupported-compatibility-responses');
}

async function coverForkDeleteLeaseAndRestart(client: LocalClient, conversationId: string): Promise<void> {
  const forkId = randomUUID();
  const forked = await client.postJson<{ id: string; title: string | null; secret_registry: Record<string, unknown> }>(`/api/conversations/${conversationId}/fork`, { id: forkId, title: 'Forked local smoke' }, 201);
  assertEqual(forked.id, forkId, 'fork uses requested id');
  assertEqual(forked.title, 'Forked local smoke', 'fork applies title');
  assert(forked.secret_registry.OH_SECRET !== undefined, 'fork copies secret registry reference');
  assertEqual((await client.deleteJson<{ success: boolean }>(`/api/conversations/${forkId}`)).success, true, 'delete fork succeeds');
  assertEqual((await client.getJson<{ detail: string }>(`/api/conversations/${forkId}`, 404)).detail, 'Conversation not found', 'deleted fork is gone');

  const second = await createAgentServerApp({
    agentFactory: localAgentFactory,
    secretStore,
    config: { conversationsPath, statePath, bashEventsPath: path.join(root, 'second-bash-events'), workspaceRoot, allowedFileRoots: [workspaceRoot], sessionApiKey },
  });
  try {
    const secondHost = await listen(second.app);
    const secondClient = new LocalClient(secondHost);
    const conflict = await secondClient.postJson<{ detail: string }>('/api/conversations', { id: conversationId }, 409);
    assert(conflict.detail.includes('conversation lease is held'), 'second server sees active lease conflict');
  } finally {
    await second.app.close();
  }

  await server!.app.close();
  server = await createAgentServerApp({
    agentFactory: localAgentFactory,
    secretStore,
    config: { conversationsPath, statePath, bashEventsPath, workspaceRoot, allowedFileRoots: [workspaceRoot], sessionApiKey },
  });
  host = await listen(server.app);
  const restartedClient = new LocalClient(host);
  assertEqual((await restartedClient.getJson<{ id: string }>(`/api/conversations/${conversationId}`)).id, conversationId, 'conversation restores after restart');
  const restoredMessages = await restartedClient.getJson<{ items: EventLike[] }>(`/api/conversations/${conversationId}/events/search?kind=MessageEvent&source=user&limit=10`);
  assert(restoredMessages.items.map(eventText).includes(asyncMessageOne), 'first user message restores after restart');
  assert(restoredMessages.items.map(eventText).includes(asyncMessageTwo), 'second user message restores after restart');
  covered.add('fork-delete-restart-persistence-lease');
}

interface AcceptedDeviation {
  readonly detail: string;
  readonly accepted_deviation: true;
  readonly feature: string;
}

interface EventLike {
  readonly id: string;
  readonly kind: string;
  readonly llm_message?: { readonly content?: unknown };
}

class LocalClient {
  constructor(private readonly baseUrl: string) {}

  async getJson<T>(route: string, expectedOrAuth: number | boolean = 200): Promise<T> {
    const auth = typeof expectedOrAuth === 'boolean' ? expectedOrAuth : true;
    const expected = typeof expectedOrAuth === 'number' ? expectedOrAuth : 200;
    return this.requestJson<T>('GET', route, undefined, expected, auth);
  }

  async postJson<T>(route: string, body: unknown, expected = 200): Promise<T> {
    return this.requestJson<T>('POST', route, body, expected, true);
  }

  async putJson<T>(route: string, body: unknown, expected = 200): Promise<T> {
    return this.requestJson<T>('PUT', route, body, expected, true);
  }

  async patchJson<T>(route: string, body: unknown, expected = 200): Promise<T> {
    return this.requestJson<T>('PATCH', route, body, expected, true);
  }

  async deleteJson<T>(route: string, expected = 200): Promise<T> {
    return this.requestJson<T>('DELETE', route, undefined, expected, true);
  }

  async getText(route: string, expected = 200): Promise<string> {
    const response = await this.raw(route);
    assertEqual(response.status, expected, `${route} status`);
    return response.text();
  }

  async raw(route: string, options: RequestInit & { readonly auth?: boolean } = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.auth !== false) headers.set('x-session-api-key', sessionApiKey);
    return fetch(`${this.baseUrl}${route}`, { ...options, headers });
  }

  private async requestJson<T>(method: string, route: string, body: unknown, expected: number, auth: boolean): Promise<T> {
    const headers = new Headers();
    if (auth) headers.set('x-session-api-key', sessionApiKey);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    assertEqual(response.status, expected, `${method} ${route} status: ${text}`);
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }
}

function localAgentFactory(): Agent {
  const llm = TestLLM.fromMessages([
    assistantToolCall('delay-call', 'delay', { ms: 200 }),
    assistantToolCall('finish-first', 'finish', { message: 'local-smoke-first-run' }),
    assistantToolCall('finish-rerun', 'finish', { message: 'local-smoke-rerun' }),
  ], { profile: llmProfile });
  return new Agent({ llm, tools: [delayTool, FinishTool.create()] });
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: [],
    tool_calls: [{ id, name, arguments: JSON.stringify(args), origin: 'completion' }],
  };
}

function eventText(event: EventLike): string {
  const content = event.llm_message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string' ? item.text : '').join('\n');
}

async function assertNoPlaintextSecretPersisted(searchRoot: string): Promise<void> {
  const matches = await filesContaining(searchRoot, dummySecretValue);
  assertEqual(matches.length, 0, `OH_SECRET dummy value must not persist in files: ${matches.join(', ')}`);
  covered.add('OH_SECRET dummy secret metadata-only persistence check');
}

async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const matches: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      matches.push(...await filesContaining(child, needle));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(child).catch(() => Buffer.alloc(0));
    if (content.includes(needle)) matches.push(child);
  }
  return matches;
}

async function listen(app: { listen: (options: { readonly host: string; readonly port: number }) => Promise<string>; server: { address: () => string | { readonly port: number } | null } }): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out opening websocket ${url}`)), 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Failed to open websocket ${url}`));
    }, { once: true });
  });
  return socket;
}

async function waitForSocketJson<T>(socket: WebSocket, predicate: (message: T) => boolean, label = 'message', timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const seen: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for websocket ${label}; saw ${seen.join(' | ')}`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const raw = String(event.data);
      seen.push(raw.slice(0, 180));
      const parsed = JSON.parse(raw) as T;
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket errored while waiting for ${label}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for ${label}; saw ${seen.join(' | ')}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAcceptedDeviation(response: AcceptedDeviation, feature: string): void {
  assertEqual(response.accepted_deviation, true, `${feature} accepted deviation flag`);
  assertEqual(response.feature, feature, `${feature} accepted deviation feature`);
  assert(response.detail.includes('intentionally not supported'), `${feature} accepted deviation detail`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
await main();