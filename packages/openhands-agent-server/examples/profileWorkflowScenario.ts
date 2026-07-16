import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LLMProfile } from '@smolpaws/openhands-agent';

import { AgentServerHttpClient, assert, assertEqual, waitFor } from './httpClient.js';
import { gitOutput, type WorkspaceFixture } from './workspaceFixture.js';

interface ScenarioOptions {
  readonly client: AgentServerHttpClient;
  readonly profiles: readonly [LLMProfile, LLMProfile];
  readonly apiKey: string;
  readonly conversationsPath: string;
  readonly firstWorkspace: WorkspaceFixture;
  readonly secondWorkspace: WorkspaceFixture;
}

interface ConversationInfo {
  readonly id: string;
  readonly execution_status: string;
  readonly max_iterations: number;
  readonly agent: { readonly llm_profile_ref?: string };
  readonly workspace: { readonly working_dir: string };
}

interface EventRecord {
  readonly id: string;
  readonly kind: string;
}

export interface ProfileWorkflowResult {
  readonly profiles: Array<{ readonly id: string; readonly model: string }>;
  readonly conversations: Array<{
    readonly id: string;
    readonly profile: string;
    readonly max_iterations: number;
    readonly workspace: string;
    readonly final_response: string;
  }>;
  readonly first_readme_changed: true;
  readonly second_readme_unchanged: true;
  readonly git_head_unchanged: true;
  readonly independent_conversation_directories: true;
  readonly covered_operations: readonly string[];
}

export async function runProfileWorkflowScenario(options: ScenarioOptions): Promise<ProfileWorkflowResult> {
  const [nano, mini] = options.profiles;
  const covered = new Set<string>();
  await coverServerMetadata(options.client, covered);
  await createProfilesWithLifecycle(options.client, nano, mini, covered);
  await storeAndVerifyDummySecret(options.client, covered);

  const nanoMaxIterations = 12;
  await activateAndConfigure(options.client, nano.profileId, nanoMaxIterations, options.apiKey);
  const first = await createConversation(options.client, nano.profileId, nanoMaxIterations, options.firstWorkspace.directory, 'README summary and edit');
  covered.add('profiles/activate-settings-snapshot');
  covered.add('conversations/create-profile-snapshot');

  const firstReadme = path.join(options.firstWorkspace.directory, 'README.md');
  const secondReadme = path.join(options.secondWorkspace.directory, 'README.md');
  await sendAndRun(options.client, first.id, `Read ${firstReadme} using the available tools. Do not modify any files. Summarize the package and its purpose in at most 120 words, then call finish with only that summary.`);
  const firstSummary = await waitForFinalResponse(options.client, first.id);
  assertEqual(await readFile(path.join(options.firstWorkspace.directory, 'README.md'), 'utf8'), options.firstWorkspace.originalReadme, 'first task leaves README unchanged');
  await coverConversationAndEvents(options.client, first.id, covered);

  await sendAndRun(options.client, first.id, `Using your previous summary, replace ${firstReadme} with that concise summary. You are running inside a local workspace with working file tools; do not say you cannot modify files. Use file_editor or terminal to overwrite that exact absolute path, change no other file, verify git status shows only README.md modified, then call finish with the exact text README_EDITED.`);
  const firstFinal = await waitForFinalResponse(options.client, first.id, 'README_EDITED');
  const editedReadme = await readFile(path.join(options.firstWorkspace.directory, 'README.md'), 'utf8');
  assert(editedReadme !== options.firstWorkspace.originalReadme, 'first README was edited');
  assert(editedReadme.trim().length > 0, 'edited README is non-empty');
  await coverFileAndGitEvidence(options.client, options.firstWorkspace.directory, covered);
  await coverConversationFork(options.client, first.id, covered);

  const miniMaxIterations = 6;
  await activateAndConfigure(options.client, mini.profileId, miniMaxIterations, options.apiKey);
  const second = await createConversation(options.client, mini.profileId, miniMaxIterations, options.secondWorkspace.directory, 'Independent README summary');
  assert(second.id !== first.id, 'second conversation has an independent id');
  await sendAndRun(options.client, second.id, `Read ${secondReadme} using the available tools. Do not modify any files. Call finish with one sentence naming the package and explaining what it provides.`);
  const secondFinal = await waitForFinalResponse(options.client, second.id);
  assertEqual(await readFile(path.join(options.secondWorkspace.directory, 'README.md'), 'utf8'), options.secondWorkspace.originalReadme, 'second README remains unchanged');
  await coverConversationAndEvents(options.client, second.id, covered);

  assertEqual((await gitOutput(options.firstWorkspace.directory, ['rev-parse', 'HEAD'])).trim(), options.firstWorkspace.initialHead, 'first workspace has no agent commit');
  assertEqual((await gitOutput(options.secondWorkspace.directory, ['rev-parse', 'HEAD'])).trim(), options.secondWorkspace.initialHead, 'second workspace has no agent commit');
  assert((await stat(path.join(options.conversationsPath, first.id))).isDirectory(), 'first conversation persistence directory exists');
  assert((await stat(path.join(options.conversationsPath, second.id))).isDirectory(), 'second conversation persistence directory exists');

  await options.client.deleteJson('/api/settings/secrets/PROFILE_WORKFLOW_DUMMY');
  covered.add('settings/secrets-create-list-mask-delete');
  covered.add('filesystem/two-workspaces-two-conversation-directories');

  return {
    profiles: options.profiles.map((profile) => ({ id: profile.profileId, model: profile.model })),
    conversations: [
      { id: first.id, profile: nano.profileId, max_iterations: first.max_iterations, workspace: first.workspace.working_dir, final_response: `${firstSummary}\n${firstFinal}` },
      { id: second.id, profile: mini.profileId, max_iterations: second.max_iterations, workspace: second.workspace.working_dir, final_response: secondFinal },
    ],
    first_readme_changed: true,
    second_readme_unchanged: true,
    git_head_unchanged: true,
    independent_conversation_directories: true,
    covered_operations: [...covered].sort(),
  };
}

async function coverServerMetadata(client: AgentServerHttpClient, covered: Set<string>): Promise<void> {
  assertEqual((await client.raw('/api/settings', false)).status, 401, 'missing session key is rejected');
  assertEqual((await client.getJson<{ status: string }>('/health')).status, 'ok', 'health status');
  assertEqual((await client.getJson<{ status: string }>('/ready')).status, 'ready', 'ready status');
  const openapi = await client.getJson<{ paths: Record<string, unknown> }>('/openapi.json');
  assert(openapi.paths['/api/profiles/{name}/activate'] !== undefined, 'OpenAPI includes profile activation');
  assert(openapi.paths['/api/conversations/{conversation_id}/run'] !== undefined, 'OpenAPI includes conversation run');
  assert((await client.getJson<{ schema: unknown }>('/api/settings/agent-schema')).schema !== undefined, 'agent settings schema is available');
  assert((await client.getJson<{ schema: unknown }>('/api/settings/conversation-schema')).schema !== undefined, 'conversation settings schema is available');
  covered.add('auth-health-ready-openapi-settings-schemas');
}

async function createProfilesWithLifecycle(client: AgentServerHttpClient, nano: LLMProfile, mini: LLMProfile, covered: Set<string>): Promise<void> {
  await client.postJson('/api/profiles', nano, 201);
  await client.postJson('/api/profiles', mini, 201);
  assertEqual((await client.getJson<LLMProfile>(`/api/profiles/${nano.profileId}`)).model, nano.model, 'nano profile model');
  await client.deleteJson(`/api/profiles/${mini.profileId}`);
  assertEqual((await client.raw(`/api/profiles/${mini.profileId}`)).status, 404, 'deleted mini profile is absent');
  await client.postJson(`/api/profiles/${mini.profileId}`, mini, 201);
  const listed = await client.getJson<{ profiles: LLMProfile[] }>('/api/profiles');
  assert(listed.profiles.some((profile) => profile.profileId === nano.profileId), 'profile list includes nano');
  assert(listed.profiles.some((profile) => profile.profileId === mini.profileId), 'profile list includes re-added mini');
  covered.add('profiles/create-get-list-delete-readd');
}

async function storeAndVerifyDummySecret(client: AgentServerHttpClient, covered: Set<string>): Promise<void> {
  const value = 'profile-workflow-dummy-secret-not-persisted';
  await client.putJson('/api/settings/secrets', { name: 'PROFILE_WORKFLOW_DUMMY', value });
  const listed = await client.getJson<{ secrets: Array<{ readonly name: string; readonly value?: string }> }>('/api/settings/secrets');
  assert(listed.secrets.some((secret) => secret.name === 'PROFILE_WORKFLOW_DUMMY' && secret.value === undefined), 'dummy secret is listed without plaintext');
  assertEqual((await client.getJson<{ value: string }>('/api/settings/secrets/PROFILE_WORKFLOW_DUMMY')).value, '**********', 'dummy secret is masked');
  covered.add('settings/secrets-create-list-mask');
}

async function activateAndConfigure(client: AgentServerHttpClient, profileId: string, maxIterations: number, apiKey: string): Promise<void> {
  await client.postJson(`/api/profiles/${profileId}/activate`, {});
  const current = await client.getJson<{
    active_profile_id: string | null;
    agent_settings: { readonly agent_kind: string; readonly llm_profile_ref?: string };
    conversation_settings: Record<string, unknown>;
  }>('/api/settings');
  assertEqual(current.active_profile_id, profileId, 'active profile id');
  assertEqual(current.agent_settings.llm_profile_ref, profileId, 'agent settings profile ref');
  const updated = await client.patchJson<{
    active_profile_id: string | null;
    llm_api_key_set: boolean;
    agent_settings: { readonly llm_profile_ref?: string };
    conversation_settings: { readonly max_iterations: number };
  }>('/api/settings', {
    conversation_settings: { ...current.conversation_settings, max_iterations: maxIterations },
    llm_api_key: apiKey,
  });
  assertEqual(updated.active_profile_id, profileId, 'updated active profile');
  assertEqual(updated.agent_settings.llm_profile_ref, profileId, 'updated settings profile ref');
  assertEqual(updated.conversation_settings.max_iterations, maxIterations, 'updated max iterations');
  assertEqual(updated.llm_api_key_set, true, 'active profile API key is set');
}

async function createConversation(client: AgentServerHttpClient, profileId: string, maxIterations: number, workspace: string, title: string): Promise<ConversationInfo> {
  const conversation = await client.postJson<ConversationInfo>('/api/conversations', {
    workspace: { kind: 'LocalWorkspace', working_dir: workspace },
    title,
    tags: { profile: profileId, scenario: 'profile-workflow' },
  }, 201);
  assertEqual(conversation.agent.llm_profile_ref, profileId, 'conversation profile snapshot');
  assertEqual(conversation.max_iterations, maxIterations, 'conversation max-iterations snapshot');
  assertEqual(conversation.workspace.working_dir, workspace, 'conversation workspace');
  return conversation;
}

async function sendAndRun(client: AgentServerHttpClient, conversationId: string, prompt: string): Promise<void> {
  await client.postJson(`/api/conversations/${conversationId}/events`, { role: 'user', content: [{ type: 'text', text: prompt }], run: false });
  await client.postJson(`/api/conversations/${conversationId}/run`, {});
}

async function waitForFinalResponse(client: AgentServerHttpClient, conversationId: string, expectedSubstring?: string): Promise<string> {
  let response = '';
  await waitFor(async () => {
    const info = await client.getJson<ConversationInfo>(`/api/conversations/${conversationId}`);
    if (info.execution_status === 'idle' || info.execution_status === 'running') throw new Error(`${conversationId} is ${info.execution_status}`);
    response = (await client.getJson<{ response: string }>(`/api/conversations/${conversationId}/agent_final_response`)).response;
    assert(response.length > 0, `${conversationId} has a final response`);
    if (expectedSubstring !== undefined) assert(response.includes(expectedSubstring), `${conversationId} response includes ${expectedSubstring}: ${response}`);
  }, 240_000);
  return response;
}

async function coverConversationAndEvents(client: AgentServerHttpClient, conversationId: string, covered: Set<string>): Promise<void> {
  const info = await client.getJson<ConversationInfo>(`/api/conversations/${conversationId}`);
  assert(info.execution_status !== 'idle' && info.execution_status !== 'running', 'conversation reached terminal state');
  const page = await client.getJson<{ items: EventRecord[] }>(`/api/conversations/${conversationId}/events/search?source=user&limit=20`);
  assert(page.items.length > 0, 'event search returns user event');
  const event = page.items[0];
  assert(event !== undefined, 'first event exists');
  assertEqual((await client.getJson<EventRecord>(`/api/conversations/${conversationId}/events/${event.id}`)).id, event.id, 'event get by id');
  assertEqual((await client.getJson<Array<EventRecord | null>>(`/api/conversations/${conversationId}/events?event_ids=${encodeURIComponent(event.id)}`))[0]?.id, event.id, 'event batch get');
  assert((await client.getJson<number>(`/api/conversations/${conversationId}/events/count`)) > 1, 'event count includes run activity');
  const search = await client.getJson<{ items: ConversationInfo[] }>('/api/conversations/search?limit=20');
  assert(search.items.some((conversation) => conversation.id === conversationId), 'conversation search includes conversation');
  assert((await client.getJson<number>('/api/conversations/count')) >= 1, 'conversation count is positive');
  assertEqual((await client.getJson<Array<ConversationInfo | null>>(`/api/conversations?ids=${encodeURIComponent(conversationId)}`))[0]?.id, conversationId, 'conversation batch get');
  await client.patchJson(`/api/conversations/${conversationId}`, { title: `Completed ${conversationId.slice(0, 8)}`, tags: { status: 'completed' } });
  covered.add('conversations/get-search-count-batch-patch-final-response');
  covered.add('events/post-run-search-count-get-batch');
}

async function coverFileAndGitEvidence(client: AgentServerHttpClient, workspace: string, covered: Set<string>): Promise<void> {
  const readme = path.join(workspace, 'README.md');
  const downloaded = await client.getText(`/api/file/download?path=${encodeURIComponent(readme)}`);
  assert(downloaded.trim().length > 0, 'file download returns edited README');
  const directories = await client.getJson<{ items: Array<{ readonly name: string }> }>(`/api/file/search_subdirs?path=${encodeURIComponent(path.dirname(workspace))}&limit=20`);
  assert(directories.items.some((item) => item.name === path.basename(workspace)), 'file search includes first workspace');
  const changes = await client.getJson<Array<{ readonly path: string; readonly status: string }>>(`/api/git/changes?path=${encodeURIComponent(workspace)}`);
  assert(changes.some((change) => change.path === 'README.md' && change.status === 'UPDATED'), 'git changes reports README only');
  assert(changes.every((change) => change.path === 'README.md'), 'agent changed no other tracked or untracked file');
  const diff = await client.getJson<{ readonly original: string | null; readonly modified: string | null }>(`/api/git/diff?path=${encodeURIComponent(readme)}`);
  assert(diff.original !== diff.modified, 'git diff shows README change');
  covered.add('file/download-search-subdirs');
  covered.add('git/changes-diff');
}

async function coverConversationFork(client: AgentServerHttpClient, conversationId: string, covered: Set<string>): Promise<void> {
  const fork = await client.postJson<ConversationInfo>(`/api/conversations/${conversationId}/fork`, { title: 'Profile workflow fork', tags: { scenario: 'fork-check' } }, 201);
  assert(fork.id !== conversationId, 'fork has independent id');
  assert((await client.getJson<number>(`/api/conversations/${fork.id}/events/count`)) > 0, 'fork copies events');
  await client.deleteJson(`/api/conversations/${fork.id}`);
  assertEqual((await client.raw(`/api/conversations/${fork.id}`)).status, 404, 'deleted fork is absent');
  covered.add('conversations/fork-delete');
}
