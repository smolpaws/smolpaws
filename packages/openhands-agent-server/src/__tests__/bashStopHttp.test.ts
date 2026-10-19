import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, RemoteWorkspace } from '@smolpaws/openhands-agent';
import { expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';

test('vendored workspace stops a command through authenticated HTTP and tolerates unknown IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bash-stop-http-'));
  const server = await createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    config: { conversationsPath: root, workspaceRoot: root, sessionApiKey: 'fixture-key' },
  });
  try {
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const workspace = new RemoteWorkspace({ host: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-key', workingDir: root });
    const commandId = await workspace.startCommand('sleep 30', { cwd: root });
    const url = `/api/bash/bash_commands/${commandId}/stop`;
    expect((await server.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect(await workspace.getCommandOutput(commandId)).toBeNull();
    await workspace.stopCommand(commandId);
    expect(await workspace.getCommandOutput(commandId)).toMatchObject({ command_id: commandId, exit_code: -15 });
    await expect(workspace.stopCommand(commandId)).resolves.toBeUndefined();
    await expect(workspace.stopCommand('11111111-1111-4111-8111-111111111111')).resolves.toBeUndefined();
    expect((await server.app.inject({ method: 'POST', url: '/api/bash/bash_commands/not-a-uuid/stop', headers: { 'x-session-api-key': 'fixture-key' } })).statusCode).toBe(422);
  } finally {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
