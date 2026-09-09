import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';
import { ConversationLease, ConversationLeaseInvalidError, leaseFileName } from '../conversationLease.js';
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

  test('rejects injected services combined with managed service inputs', async () => {
    const server = await createAgentServerApp({ secretStore: new InMemorySecretStore() });
    try {
      await expect(createAgentServerApp({ conversationService: server.conversationService, ownerInstanceId: 'ignored' })).rejects.toThrow(/cannot be combined/u);
    } finally {
      await server.app.close();
    }
  });
});
