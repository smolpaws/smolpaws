import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerAppOptions } from '../app.js';
import {
  ConversationLease,
  ConversationLeaseHeldError,
  ConversationLeaseInvalidError,
  leaseFileName,
} from '../conversationLease.js';
import { InMemorySecretStore } from '@smolpaws/openhands-agent';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function conversationDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversation-lease-'));
  roots.push(root);
  const dir = path.join(root, 'conversation');
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('ConversationLease', () => {
  test.each([
    ['malformed JSON', '{'],
    ['partial payload', JSON.stringify({ owner_instance_id: 'owner' })],
    ['non-string owner_host', JSON.stringify({ owner_instance_id: 'owner', generation: 1, expires_at: Date.now() + 60_000, owner_host: 42 })],
    ['non-number owner_pid', JSON.stringify({ owner_instance_id: 'owner', generation: 1, expires_at: Date.now() + 60_000, owner_pid: '123' })],
    ['non-positive owner_pid', JSON.stringify({ owner_instance_id: 'owner', generation: 1, expires_at: Date.now() + 60_000, owner_pid: 0 })],
    ['non-integer owner_pid', JSON.stringify({ owner_instance_id: 'owner', generation: 1, expires_at: Date.now() + 60_000, owner_pid: 1.5 })],
  ])('fails closed for %s', async (_label, contents) => {
    const dir = await conversationDir();
    await writeFile(path.join(dir, leaseFileName), contents, 'utf8');
    await expect(new ConversationLease(dir, 'replacement').claim()).rejects.toBeInstanceOf(ConversationLeaseInvalidError);
  });

  test('fails closed when the lease path cannot be read as a file', async () => {
    const dir = await conversationDir();
    await mkdir(path.join(dir, leaseFileName));
    await expect(new ConversationLease(dir, 'replacement').claim()).rejects.toBeInstanceOf(ConversationLeaseInvalidError);
  });

  test('fails closed when permission to read the lease is denied', async () => {
    const dir = await conversationDir();
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(permissionError);
    try {
      await expect(new ConversationLease(dir, 'replacement').claim()).rejects.toMatchObject({
        name: 'ConversationLeaseInvalidError',
        cause: { code: 'EACCES' },
      });
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test('keeps a legacy lease without optional owner metadata held until expiry', async () => {
    const dir = await conversationDir();
    await writeFile(path.join(dir, leaseFileName), JSON.stringify({
      owner_instance_id: 'legacy-owner',
      generation: 4,
      expires_at: Date.now() + 60_000,
    }), 'utf8');

    await expect(new ConversationLease(dir, 'replacement').claim()).rejects.toBeInstanceOf(ConversationLeaseHeldError);
  });

  test('keeps an unexpired lease held while its local owner is healthy', async () => {
    const dir = await conversationDir();
    await writeFile(path.join(dir, leaseFileName), JSON.stringify({
      owner_instance_id: 'healthy-owner',
      generation: 4,
      expires_at: Date.now() + 60_000,
      owner_host: os.hostname(),
      owner_pid: process.pid,
    }), 'utf8');

    await expect(new ConversationLease(dir, 'replacement').claim()).rejects.toBeInstanceOf(ConversationLeaseHeldError);
  });

  test('takes over an unexpired lease when its local owner process is gone', async () => {
    const dir = await conversationDir();
    await writeFile(path.join(dir, leaseFileName), JSON.stringify({
      owner_instance_id: 'stale-owner',
      generation: 4,
      expires_at: Date.now() + 60_000,
      owner_host: os.hostname(),
      owner_pid: 2_147_483_647,
    }), 'utf8');

    await expect(new ConversationLease(dir, 'replacement').claim()).resolves.toEqual({ generation: 5, takeover: true });
  });

  test('takes over an expired lease even if its local owner is still healthy', async () => {
    const dir = await conversationDir();
    await writeFile(path.join(dir, leaseFileName), JSON.stringify({
      owner_instance_id: 'expired-owner',
      generation: 4,
      expires_at: Date.now() - 1,
      owner_host: os.hostname(),
      owner_pid: process.pid,
    }), 'utf8');

    await expect(new ConversationLease(dir, 'replacement').claim()).resolves.toEqual({ generation: 5, takeover: true });
  });

  test('managed app construction forwards owner and TTL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'managed-lease-'));
    roots.push(root);
    const conversationsPath = path.join(root, 'conversations');
    const before = Date.now();
    const server = await createAgentServerApp({
      persistenceDir: conversationsPath,
      ownerInstanceId: 'configured-owner',
      leaseTtlMs: 12_345,
      secretStore: new InMemorySecretStore(),
    });
    try {
      const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { id: '11111111-1111-4111-8111-111111111111' } });
      expect(response.statusCode).toBe(201);
      const payload = JSON.parse(await readFile(path.join(conversationsPath, '11111111-1111-4111-8111-111111111111', leaseFileName), 'utf8')) as { owner_instance_id: string; expires_at: number };
      expect(payload.owner_instance_id).toBe('configured-owner');
      expect(payload.expires_at).toBeGreaterThanOrEqual(before + 12_345);
      expect(payload.expires_at).toBeLessThanOrEqual(Date.now() + 12_345);
    } finally {
      await server.app.close();
    }
  });

  test.each([
    ['agent factory', { agentFactory: async () => { throw new Error('unused'); } }],
    ['persistence directory', { persistenceDir: path.join(os.tmpdir(), 'ignored-conversation-path') }],
    ['owner ID', { ownerInstanceId: 'ignored' }],
    ['lease TTL', { leaseTtlMs: 1_000 }],
    ['configured conversation path', { config: { conversationsPath: path.join(os.tmpdir(), 'ignored-config-path') } }],
  ] satisfies ReadonlyArray<readonly [string, AgentServerAppOptions]>)('rejects an injected service combined with a managed %s', async (_label, managedOptions) => {
    const server = await createAgentServerApp({ secretStore: new InMemorySecretStore() });
    try {
      await expect(createAgentServerApp({ ...managedOptions, conversationService: server.conversationService })).rejects.toThrow(/cannot be combined/u);
    } finally {
      await server.app.close();
    }
  });

  test('rejects contradictory managed persistence paths', async () => {
    await expect(createAgentServerApp({
      persistenceDir: path.join(os.tmpdir(), 'direct-conversation-path'),
      config: { conversationsPath: path.join(os.tmpdir(), 'configured-conversation-path') },
    })).rejects.toThrow(/must match/u);
  });
});
