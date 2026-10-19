import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationService } from '../conversationService.js';
import { ConversationLease, leaseFileName } from '../conversationLease.js';
import { startConversationRequestSchema, forkConversationRequestSchema } from '../models.js';
const roots: string[] = [], services: ConversationService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each(['create', 'fork'])('failed %s cleanup cannot delete a successor owner after generation loss', async kind => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'initialization-ownership-')); roots.push(root);
  const service = new ConversationService({ persistenceDir: root, secretStore: new InMemorySecretStore() }); services.push(service);
  const source = await service.startConversation(startConversationRequestSchema.parse({}));
  const id = randomUUID(), directory = path.join(root, id), leasePath = path.join(directory, leaseFileName);
  const originalClaim = ConversationLease.prototype.claim;
  let stolen = false;
  vi.spyOn(ConversationLease.prototype, 'claim').mockImplementation(async function () {
    const claim = await originalClaim.call(this);
    if (this.conversationDir !== directory || stolen) return claim;
    stolen = true;
    // Model an expired lease and a real successor claim before the old initializer
    // resumes. The returned old generation must never authorize cleanup.
    const previous = JSON.parse(await readFile(leasePath, 'utf8'));
    await writeFile(leasePath, JSON.stringify({ ...previous, expires_at: 0 }));
    await originalClaim.call(new ConversationLease(directory, 'successor-owner'));
    await writeFile(path.join(directory, 'winner-data.json'), JSON.stringify({ keep: true }));
    return claim;
  });
  const operation = kind === 'create'
    ? service.startConversation(startConversationRequestSchema.parse({ id }))
    : service.forkConversation(source.info.id, forkConversationRequestSchema.parse({ id }));
  await expect(operation).rejects.toThrow(/ownership.*lost/);
  expect(JSON.parse(await readFile(path.join(directory, 'winner-data.json'), 'utf8'))).toEqual({ keep: true });
  expect(JSON.parse(await readFile(leasePath, 'utf8')).owner_instance_id).toBe('successor-owner');
  expect(await service.getConversation(id)).toBeNull();
});
