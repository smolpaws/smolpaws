import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const leaseFileName = 'owner_lease.json';
export const leaseLockFileName = '.owner_lease.lock';
export const defaultLeaseTtlMs = 45_000;

export interface LeaseClaim {
  readonly generation: number;
  readonly takeover: boolean;
}

interface LeasePayload {
  readonly owner_instance_id: string;
  readonly generation: number;
  readonly expires_at: number;
  readonly owner_host?: string;
  readonly owner_pid?: number;
}

export class ConversationLeaseHeldError extends Error {
  override readonly name = 'ConversationLeaseHeldError';

  constructor(readonly conversationDir: string, readonly ownerInstanceId: string, readonly expiresAt: number) {
    super(`conversation lease is held by ${ownerInstanceId} until ${expiresAt}`);
  }
}

export class ConversationOwnershipLostError extends Error {
  override readonly name = 'ConversationOwnershipLostError';

  constructor(readonly conversationDir: string, readonly ownerInstanceId: string, readonly generation: number) {
    super('conversation ownership was lost before the write completed');
  }
}

export class ConversationLeaseInvalidError extends Error {
  override readonly name = 'ConversationLeaseInvalidError';

  constructor(readonly conversationDir: string, message: string, options?: ErrorOptions) {
    super(`conversation lease is invalid: ${message}`, options);
  }
}

export class ConversationLease {
  private readonly leasePath: string;
  private readonly lockPath: string;

  constructor(readonly conversationDir: string, private readonly ownerInstanceId: string, private readonly ttlMs = defaultLeaseTtlMs) {
    this.leasePath = path.join(conversationDir, leaseFileName);
    this.lockPath = path.join(conversationDir, leaseLockFileName);
  }

  async claim(): Promise<LeaseClaim> {
    await fs.mkdir(this.conversationDir, { recursive: true });
    return this.withLock(async () => {
      const now = Date.now();
      const payload = await this.readPayload();
      if (payload === null) {
        await this.writePayload(1, now + this.ttlMs);
        return { generation: 1, takeover: false };
      }
      const sameOwner = payload.owner_instance_id === this.ownerInstanceId;
      if (!sameOwner && payload.expires_at > now && !ownerIsDead(payload)) {
        throw new ConversationLeaseHeldError(this.conversationDir, payload.owner_instance_id, payload.expires_at);
      }
      const generation = sameOwner ? payload.generation : payload.generation + 1;
      await this.writePayload(generation, now + this.ttlMs);
      return { generation, takeover: !sameOwner };
    });
  }

  async renew(generation: number): Promise<void> {
    await this.withLock(async () => {
      await this.assertOwnerLocked(generation);
      await this.writePayload(generation, Date.now() + this.ttlMs);
    });
  }

  async guardedWrite<T>(generation: number, write: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.assertOwnerLocked(generation);
      return write();
    });
  }

  async release(generation: number): Promise<void> {
    await this.withLock(async () => {
      const payload = await this.readPayload();
      if (payload === null) return;
      if (payload.owner_instance_id !== this.ownerInstanceId || payload.generation !== generation) return;
      await fs.rm(this.leasePath, { force: true });
    }).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
  }

  private async assertOwnerLocked(generation: number): Promise<void> {
    const payload = await this.readPayload();
    if (payload?.owner_instance_id !== this.ownerInstanceId || payload.generation !== generation) {
      throw new ConversationOwnershipLostError(this.conversationDir, this.ownerInstanceId, generation);
    }
  }

  private async readPayload(): Promise<LeasePayload | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.leasePath, 'utf8')) as unknown;
      if (!isLeasePayload(raw)) {
        throw new ConversationLeaseInvalidError(this.conversationDir, 'payload does not match the lease schema');
      }
      return {
        owner_instance_id: raw.owner_instance_id,
        generation: raw.generation,
        expires_at: raw.expires_at,
        ...(typeof raw.owner_host === 'string' ? { owner_host: raw.owner_host } : {}),
        ...(typeof raw.owner_pid === 'number' ? { owner_pid: raw.owner_pid } : {}),
      };
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return null;
      if (error instanceof ConversationLeaseInvalidError) throw error;
      const message = error instanceof SyntaxError ? 'payload is not valid JSON' : 'lease file could not be read';
      throw new ConversationLeaseInvalidError(this.conversationDir, message, { cause: error });
    }
  }

  private async writePayload(generation: number, expiresAt: number): Promise<void> {
    const payload: LeasePayload = { owner_instance_id: this.ownerInstanceId, generation, expires_at: expiresAt, owner_host: os.hostname(), owner_pid: process.pid };
    const tmp = `${this.leasePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.leasePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const handle = await acquireLock(this.lockPath);
    try {
      return await operation();
    } finally {
      await handle.close();
      await fs.rm(this.lockPath, { force: true });
    }
  }
}

async function acquireLock(lockPath: string): Promise<fs.FileHandle> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await fs.open(lockPath, 'wx');
    } catch (error) {
      if (!isErrno(error, 'EEXIST') || Date.now() > deadline) throw error;
      await sleep(25);
    }
  }
}

function ownerIsDead(payload: LeasePayload): boolean {
  if (payload.owner_host !== os.hostname() || typeof payload.owner_pid !== 'number') return false;
  if (payload.owner_pid === process.pid) return false;
  try {
    process.kill(payload.owner_pid, 0);
    return false;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return true;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLeasePayload(value: unknown): value is LeasePayload {
  if (!isRecord(value)) return false;
  const generation = value.generation;
  const expiresAt = value.expires_at;
  return typeof value.owner_instance_id === 'string'
    && value.owner_instance_id.length > 0
    && typeof generation === 'number'
    && Number.isSafeInteger(generation)
    && generation > 0
    && typeof expiresAt === 'number'
    && Number.isFinite(expiresAt);
}

function isErrno(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
