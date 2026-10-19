import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { conversationExecutionStatus, createMetricsResetEvent, metricsSnapshot, statsForEvents, type SecretStore, type ObservabilityRuntime } from '@smolpaws/openhands-agent';

import { RunAdmission, type RunSlot } from './runAdmission.js';
import { ConversationLease, ConversationLeaseHeldError, defaultLeaseTtlMs, leaseFileName, leaseLockFileName } from './conversationLease.js';
import { conversationDirectory, ConversationMetadataStore } from './conversationMetadata.js';
import { defaultErrorLogger, safeErrorDiagnostics, type ErrorLogger } from './errorDiagnostics.js';
import { conversationSecretRef, extractConversationSecrets, withoutConversationSecrets } from './conversationSecrets.js';
import { EventService, type AgentFactory, type EventServiceOptions } from './eventService.js';
import type { ProfileRuntimeOptions, UpdateConversationRequest as UpdateStoredRequest } from './profileRuntime.js';
import {
  type ConversationInfo,
  type ConversationPage,
  type ConversationSortOrder,
  type ForkConversationRequest,
  type SendMessageRequest,
  type StartConversationRequest,
  type StoredConversation,
  type UpdateConversationRequest,
  type Event,
  messageFromSendRequest,
  startConversationRequestSchema,
} from './models.js';

export interface ConversationServiceOptions {
  readonly maxConcurrentRuns?: number;
  readonly initializeOnCreate?: boolean;
  readonly observability?: ObservabilityRuntime;
  readonly errorLogger?: ErrorLogger;
  readonly agentFactory?: AgentFactory;
  readonly getDefaultAgentSettings?: EventServiceOptions['getDefaultAgentSettings'];
  readonly persistenceDir?: string;
  readonly secretStore?: SecretStore;
  readonly ownerInstanceId?: string;
  readonly leaseTtlMs?: number;
  readonly profileRuntime?: ProfileRuntimeOptions;
}

interface ClaimedLease {
  readonly lease: ConversationLease;
  readonly generation: number;
  readonly renewTimer: ReturnType<typeof setInterval>;
}

export class ConversationService {
  private closing = false;
  private readonly lifecycle = new Map<string, Promise<void>>();
  private readonly admission: RunAdmission;
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly eventServices = new Map<string, EventService>();
  private readonly leases = new Map<string, ClaimedLease>();
  private readonly errorLogger: ErrorLogger;
  private readonly metadataStore: ConversationMetadataStore;
  private readonly readyPromise: Promise<void>;
  private readonly ownerInstanceId: string;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: ConversationServiceOptions = {}) {
    this.admission = new RunAdmission(options.maxConcurrentRuns);
    this.errorLogger = options.errorLogger ?? defaultErrorLogger;
    this.metadataStore = new ConversationMetadataStore(options.persistenceDir ?? 'workspace/conversations');
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? defaultLeaseTtlMs;
    this.readyPromise = this.loadPersistedConversations();
  }

  async startConversation(
    requestInput: StartConversationRequest,
    prepareRequest?: () => StartConversationRequest | Promise<StartConversationRequest>,
  ): Promise<{ readonly info: ConversationInfo; readonly isNew: boolean }> {
    await this.readyPromise;
    const normalize = (input: StartConversationRequest): StartConversationRequest => startConversationRequestSchema.parse({
      ...input,
      ...((input.persistence_dir === undefined || input.persistence_dir === null || input.persistence_dir === 'workspace/conversations') && this.options.persistenceDir !== undefined ? { persistence_dir: this.options.persistenceDir } : {}),
    });
    const request = normalize(requestInput);
    const id = request.id ?? request.conversation_id ?? randomUUID();
    // Profile resolution belongs to admitted creation. Reattachment uses the
    // committed snapshot even when its original catalog entry no longer exists.
    const create = async (slot: RunSlot) => this.createConversation(
      prepareRequest === undefined ? request : normalize(await prepareRequest()), id, slot,
    );
    this.assertOpen();
    if (this.conversations.has(id)) {
      return this.withLifecycle(id, async () => {
        const existing = this.conversations.get(id);
        if (existing !== undefined) return { info: this.toConversationInfo(existing), isNew: false };
        const slot = this.admission.tryAcquire();
        try { return await create(slot); } finally { slot.release(); }
      });
    }
    const slot = this.admission.tryAcquire();
    try {
      return await this.withLifecycle(id, async () => {
        const existing = this.conversations.get(id);
        return existing === undefined ? create(slot) : { info: this.toConversationInfo(existing), isNew: false };
      });
    } finally { slot.release(); }
  }

  private async createConversation(request: StartConversationRequest, id: string, slot: RunSlot): Promise<{ readonly info: ConversationInfo; readonly isNew: boolean }> {
    const initialSecrets = extractConversationSecrets(request.secrets);
    const sanitizedRequest = withoutConversationSecrets(request);
    const now = new Date().toISOString();
    const stored: StoredConversation = {
      id,
      request: sanitizedRequest,
      workspace: sanitizedRequest.workspace,
      title: sanitizedRequest.title ?? null,
      tags: sanitizedRequest.tags,
      secret_names: [...initialSecrets.keys()].sort(),
      created_at: now,
      updated_at: now,
    };
    await this.claimLease(stored);
    let eventService: EventService | undefined;
    try {
      if (initialSecrets.size > 0) {
        await this.storeSecrets(id, initialSecrets);
      }
      eventService = new EventService(this.eventServiceOptions(stored));
      if (this.options.initializeOnCreate) await eventService.initialize();
      await this.saveOwnedConversation(stored);

      if (sanitizedRequest.initial_message !== undefined) {
        await this.sendInitialMessage(eventService, sanitizedRequest.initial_message, slot);
      }

      this.conversations.set(id, stored);
      this.eventServices.set(id, eventService);
      return { info: this.toConversationInfo(stored), isNew: true };
    } catch (error) {
      await this.cleanupFailedInitialization(stored, eventService);
      throw error;
    }
  }

  async getConversation(conversationId: string): Promise<ConversationInfo | null> {
    await this.readyPromise;
    const stored = this.conversations.get(conversationId);
    return stored === undefined ? null : this.toConversationInfo(stored);
  }

  async batchGetConversations(conversationIds: readonly string[]): Promise<Array<ConversationInfo | null>> {
    return Promise.all(conversationIds.map((conversationId) => this.getConversation(conversationId)));
  }

  async searchConversations(
    pageId: string | null = null,
    limit = 100,
    status: string | null = null,
    sortOrder: ConversationSortOrder = 'CREATED_AT_DESC',
  ): Promise<ConversationPage> {
    await this.readyPromise;
    const filtered = [...this.conversations.values()]
      .map((stored) => this.toConversationInfo(stored))
      .filter((info) => status === null || info.execution_status === status);
    const sorted = sortConversations(filtered, sortOrder);
    const parsedPageId = pageId === null ? 0 : Number.parseInt(pageId, 10);
    const start = Number.isNaN(parsedPageId) ? 0 : Math.max(0, parsedPageId);
    const items = sorted.slice(start, start + limit);
    const next_page_id = start + limit < sorted.length ? String(start + limit) : null;
    return { items, next_page_id };
  }

  async countConversations(status: string | null = null): Promise<number> {
    await this.readyPromise;
    return [...this.conversations.keys()].filter((conversationId) => {
      if (status === null) {
        return true;
      }
      const service = this.eventServices.get(conversationId);
      return service?.state.executionStatus === status;
    }).length;
  }

  async getEventService(conversationId: string): Promise<EventService | null> {
    await this.readyPromise;
    return this.eventServices.get(conversationId) ?? null;
  }

  async pauseConversation(conversationId: string): Promise<boolean> {
    await this.readyPromise;
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return false;
    }
    await service.pause();
    return true;
  }

  async interruptConversation(conversationId: string): Promise<boolean> {
    await this.readyPromise;
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return false;
    }
    await service.interrupt();
    return true;
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    await this.readyPromise;
    this.assertOpen();
    return this.withLifecycle(conversationId, async () => {
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return false;
    }
    const stored = this.conversations.get(conversationId);
    await service.close();
    this.eventServices.delete(conversationId);
    this.conversations.delete(conversationId);
    if (stored !== undefined) {
      await this.metadataStore.deleteConversation(stored);
      await this.releaseLease(stored.id);
    }
    return true;
    });
  }

  async updateConversation(conversationId: string, request: UpdateConversationRequest): Promise<boolean> {
    await this.readyPromise;
    const stored = this.conversations.get(conversationId);
    if (stored === undefined) {
      return false;
    }
    if (request.title !== undefined) {
      stored.title = request.title;
    }
    if (request.tags !== undefined) {
      stored.tags = request.tags;
    }
    stored.updated_at = new Date().toISOString();
    await this.saveOwnedConversation(stored);
    return true;
  }

  async generateConversationTitle(conversationId: string, maxLength: number): Promise<string | null> {
    await this.readyPromise;
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return null;
    }
    const title = await service.generateTitle(maxLength);
    const stored = this.conversations.get(conversationId);
    if (stored !== undefined) {
      stored.title = title;
      stored.updated_at = new Date().toISOString();
      await this.saveOwnedConversation(stored);
    }
    return title;
  }

  async askAgent(conversationId: string, question: string): Promise<string | null> {
    await this.readyPromise;
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return null;
    }
    return service.askAgent(question);
  }

  async condense(conversationId: string): Promise<boolean> {
    await this.readyPromise;
    const service = this.eventServices.get(conversationId);
    if (service === undefined) {
      return false;
    }
    await service.condense();
    return true;
  }

  async forkConversation(sourceConversationId: string, request: ForkConversationRequest): Promise<ConversationInfo | null> {
    await this.readyPromise;
    const source = this.conversations.get(sourceConversationId);
    const sourceService = this.eventServices.get(sourceConversationId);
    if (source === undefined || sourceService === undefined) {
      return null;
    }
    const id = request.id ?? randomUUID();
    this.assertOpen();
    return this.withLifecycle(id, async () => {
    if (this.conversations.has(id)) {
      throw new Error(`Conversation ${id} already exists`);
    }
    const now = new Date().toISOString();
    const forkRequest = startConversationRequestSchema.parse({ ...source.request, id, title: request.title ?? source.title, tags: request.tags ?? source.tags });
    const stored: StoredConversation = {
      id,
      request: withoutConversationSecrets(forkRequest),
      workspace: forkRequest.workspace,
      title: request.title ?? source.title,
      tags: request.tags ?? source.tags,
      secret_names: [...source.secret_names],
      created_at: now,
      updated_at: now,
    };
    await this.claimLease(stored);
    let eventService: EventService | undefined;
    try {
      await this.copySecrets(source.id, stored.id, stored.secret_names);
      sourceService.state.syncFromDisk();
      eventService = new EventService(this.eventServiceOptions(stored, sourceService.state.events));
      if (request.reset_metrics) {
        // Preserve the copied conversation while starting the fork's accounting
        // after a durable boundary, including when it is reopened from disk.
        await eventService.state.appendEventAsync(createMetricsResetEvent());
      }
      await this.saveOwnedConversation(stored);
      this.conversations.set(id, stored);
      this.eventServices.set(id, eventService);
      return this.toConversationInfo(stored);
    } catch (error) {
      await this.cleanupFailedInitialization(stored, eventService);
      throw error;
    }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    // Teardown must still release ownership if loading or repairing a stored
    // conversation failed (for example, when the disk is full).
    await this.readyPromise.catch(() => undefined);
    await Promise.allSettled([...this.lifecycle.values()]);
    await Promise.all([...this.eventServices.values()].map((service) => service.close()));
    await Promise.all([...this.leases.keys()].map((conversationId) => this.releaseLease(conversationId)));
    this.eventServices.clear();
    this.conversations.clear();
  }

  toConversationInfo(stored: StoredConversation): ConversationInfo {
    const eventService = this.eventServices.get(stored.id);
    eventService?.state.syncFromDisk();
    const stats = eventService?.state.stats ?? statsForEvents([]);
    return {
      id: stored.id,
      workspace: stored.workspace,
      persistence_dir: stored.request.persistence_dir,
      max_iterations: stored.request.max_iterations,
      stuck_detection: stored.request.stuck_detection,
      execution_status: eventService?.state.executionStatus ?? conversationExecutionStatus.IDLE,
      activated_knowledge_skills: [],
      invoked_skills: [],
      blocked_actions: {},
      blocked_messages: {},
      last_user_message_id: null,
      stats: { ...stats },
      secret_registry: Object.fromEntries(stored.secret_names.map((name) => [name, { source: 'keychain', ref: conversationSecretRef(stored.id, name) }])),
      agent_state: {},
      hook_config: null,
      title: stored.title,
      metrics: metricsSnapshot(stats),
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      tags: stored.tags,
      current_model_id: null,
      available_models: [],
      supports_runtime_model_switch: false,
      launched_agent_profile: stored.request.resolved_launch?.profile ?? null,
      tool_module_qualnames: { ...stored.request.tool_module_qualnames },
      agent: stored.request.agent,
      client_tools: stored.request.client_tools,
    };
  }

  private async loadPersistedConversations(): Promise<void> {
    try {
      const persisted = await this.metadataStore.loadAll();
      for (const stored of persisted) {
        if (this.conversations.has(stored.id)) continue;
        try {
          await this.claimLease(stored);
        } catch (error) {
          if (error instanceof ConversationLeaseHeldError) continue;
          throw error;
        }
        const service = new EventService(this.eventServiceOptions(stored));
        try {
          // The lease establishes that no other server owns execution. Repair only
          // disk-restored histories, before requests can append a retry or run them.
          const claimed = this.leases.get(stored.id)!;
          await claimed.lease.guardedWrite(claimed.generation, async () => {
            if (await service.recoverInterruptedTools()) {
              await this.metadataStore.saveConversation(stored);
            }
          });
          this.conversations.set(stored.id, stored);
          this.eventServices.set(stored.id, service);
        } catch (error) {
          await service.close();
          throw error;
        }
      }
    } catch (error) {
      await Promise.all([...this.eventServices.values()].map((service) => service.close()));
      await Promise.all([...this.leases.keys()].map((id) => this.releaseLease(id)));
      this.eventServices.clear();
      this.conversations.clear();
      throw error;
    }
  }

  private eventServiceOptions(stored: StoredConversation, events?: readonly Event[]): EventServiceOptions {
    return {
      stored,
      runAdmission: this.admission,
      ...(this.options.observability === undefined ? {} : { observability: this.options.observability }),
      errorLogger: this.errorLogger,
      saveConversation: (conversation) => this.saveOwnedConversation(conversation),
      updateRequest: (update) => this.updateOwnedRequest(stored, update),
      ...(this.options.profileRuntime === undefined ? {} : { profileRuntime: this.options.profileRuntime }),
      ...(this.options.agentFactory === undefined ? {} : { agentFactory: this.options.agentFactory }),
      ...(this.options.getDefaultAgentSettings === undefined ? {} : { getDefaultAgentSettings: this.options.getDefaultAgentSettings }),
      ...(events === undefined ? {} : { events }),
      ...(this.options.secretStore === undefined ? {} : { secretStore: this.options.secretStore }),
    };
  }


  private async cleanupFailedInitialization(stored: StoredConversation, service: EventService | undefined): Promise<void> {
    const claimed = this.leases.get(stored.id);
    try {
      try { await service?.close(); }
      finally {
        if (claimed !== undefined) await claimed.lease.guardedWrite(claimed.generation, async () => {
          // Keep the lock inode/path intact until its guard is released. Removing
          // the whole directory would let a successor create a different lock.
          const directory = conversationDirectory(stored, this.metadataStore.defaultRoot);
          const entries = await fs.readdir(directory);
          await Promise.all(entries.filter(name => name !== leaseFileName && name !== leaseLockFileName)
            .map(name => fs.rm(path.join(directory, name), { recursive: true, force: true })));
          if (this.options.secretStore !== undefined) await Promise.all(stored.secret_names
            .map(name => this.options.secretStore!.delete(conversationSecretRef(stored.id, name))));
        });
      }
    } catch (error) { this.logCleanupError(stored.id, error); }
    finally {
      try { await this.releaseLease(stored.id); }
      catch (error) { this.logCleanupError(stored.id, error); }
    }
  }

  private logCleanupError(id: string, error: unknown): void {
    try { this.errorLogger.error({ conversation_id: id, error: safeErrorDiagnostics(error) }, 'conversation_initialization_cleanup_error'); }
    catch { /* Cleanup must preserve the original initialization failure. */ }
  }

  private async saveOwnedConversation(stored: StoredConversation): Promise<void> {
    const claimed = this.leases.get(stored.id);
    if (claimed === undefined) {
      throw new Error(`conversation ${stored.id} is not owned by this server instance`);
    }
    await claimed.lease.guardedWrite(claimed.generation, () => this.metadataStore.saveConversation(stored));
  }

  private async updateOwnedRequest(stored: StoredConversation, update: Parameters<UpdateStoredRequest>[0]): Promise<void> {
    const claimed = this.leases.get(stored.id);
    if (claimed === undefined) throw new Error(`conversation ${stored.id} is not owned by this server instance`);
    await claimed.lease.guardedWrite(claimed.generation, async () => {
      const request = startConversationRequestSchema.parse(update(stored.request));
      const updated_at = new Date().toISOString();
      await this.metadataStore.saveConversation({ ...stored, request, updated_at });
      // Publish in memory before releasing the guard, so queued metadata saves see the new request.
      stored.request = request;
      stored.updated_at = updated_at;
    });
  }

  private async claimLease(stored: StoredConversation): Promise<void> {
    if (this.leases.has(stored.id)) return;
    const lease = new ConversationLease(conversationDirectory(stored, this.metadataStore.defaultRoot), this.ownerInstanceId, this.leaseTtlMs);
    const claim = await lease.claim();
    const renewEveryMs = Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    const renewTimer = setInterval(() => {
      void lease.renew(claim.generation).catch((error: unknown) => {
        this.errorLogger.error({ conversation_id: stored.id, error: safeErrorDiagnostics(error) }, 'conversation_lease_renew_error');
      });
    }, renewEveryMs);
    renewTimer.unref?.();
    this.leases.set(stored.id, { lease, generation: claim.generation, renewTimer });
  }

  private async releaseLease(conversationId: string): Promise<void> {
    const claimed = this.leases.get(conversationId);
    if (claimed === undefined) return;
    clearInterval(claimed.renewTimer);
    this.leases.delete(conversationId);
    await claimed.lease.release(claimed.generation);
  }

  private async storeSecrets(conversationId: string, secrets: ReadonlyMap<string, string>): Promise<void> {
    const store = this.options.secretStore;
    if (store === undefined) {
      throw new Error('conversation_secret_store_not_configured');
    }
    await Promise.all([...secrets].map(([name, value]) => store.set(conversationSecretRef(conversationId, name), value)));
  }

  private async copySecrets(sourceConversationId: string, targetConversationId: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    const store = this.options.secretStore;
    if (store === undefined) {
      throw new Error('conversation_secret_store_not_configured');
    }
    await Promise.all(names.map(async (name) => {
      const value = await store.get(conversationSecretRef(sourceConversationId, name));
      if (value !== null) {
        await store.set(conversationSecretRef(targetConversationId, name), value);
      }
    }));
  }



  private async sendInitialMessage(eventService: EventService, request: SendMessageRequest, slot: RunSlot): Promise<void> {
    await eventService.sendMessage(messageFromSendRequest(request), false, request.event_id);
    if (request.run) await eventService.run({ runSlot: slot });
  }

  private assertOpen(): void { if (this.closing) throw new Error('Conversation service is closing.'); }

  private async withLifecycle<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.get(id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn);
    this.lifecycle.set(id, tail);
    await previous;
    try { return await work(); }
    finally { release(); if (this.lifecycle.get(id) === tail) this.lifecycle.delete(id); }
  }
}

function sortConversations(items: readonly ConversationInfo[], sortOrder: ConversationSortOrder): ConversationInfo[] {
  return [...items].sort((left, right) => {
    const field = sortOrder === 'CREATED_AT' || sortOrder === 'CREATED_AT_DESC' ? 'created_at' : 'updated_at';
    const direction = sortOrder.endsWith('_DESC') ? -1 : 1;
    return direction * left[field].localeCompare(right[field]);
  });
}
