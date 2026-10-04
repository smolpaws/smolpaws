import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, RemoteConversation, TestLLM, defaultAgentSettings, llmProfileSchema } from '@smolpaws/openhands-agent';
import { expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';

// Exercise the installed vendored SDK through the real HTTP/profile boundary.
// A mocked successful POST concealed PR53's ignored agent_settings field.
test('vendored SDK creates with the selected profile, attaches, and rejects a missing profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-sdk-contract-'));
  const workingDir = path.join(root, 'workspace');
  await mkdir(workingDir);
  const server = await createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    llmClientFactory: () => Promise.resolve(TestLLM.fromMessages([])),
    config: {
      workspaceRoot: workingDir,
      allowedFileRoots: [workingDir],
      conversationsPath: path.join(root, 'conversations'),
      statePath: path.join(root, 'state'),
      bashEventsPath: path.join(root, 'bash'),
      sessionApiKey: 'remote-sdk-test-key',
    },
  });
  try {
    await server.serverStateService.saveProfile(llmProfileSchema.parse({
      profileId: 'remote-requested', providerId: 'openai', model: 'test-model',
    }));
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address() as AddressInfo;
    const options = { host: `http://127.0.0.1:${address.port}`, apiKey: 'remote-sdk-test-key' };
    const request = {
      workspace: { kind: 'LocalWorkspace' as const, working_dir: workingDir },
      agentSettings: defaultAgentSettings('remote-requested'),
    };
    const created = await RemoteConversation.create({ ...options, request });
    const info = await server.conversationService.getConversation(created.id);
    expect(info).toMatchObject({ id: created.id, agent: { llm_profile_ref: 'remote-requested' } });
    const attached = await RemoteConversation.attach({ ...options, conversationId: created.id.replaceAll('-', '') });
    expect(attached.id).toBe(created.id);
    expect(attached.state.executionStatus).toBe(created.state.executionStatus);
    await expect(RemoteConversation.create({
      ...options, request: { ...request, agentSettings: defaultAgentSettings('remote-missing') },
    })).rejects.toThrow(/llm_profile_not_found/u);
  } finally {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
