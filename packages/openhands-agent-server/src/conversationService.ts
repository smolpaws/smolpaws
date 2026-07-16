import { randomUUID } from 'node:crypto';

import { conversationExecutionStatus, type SecretStore } from '@smolpaws/openhands-agent';

import { ConversationLease, ConversationLeaseHeldError, defaultLeaseTtlMs } from './conversationLease.js';
import { conversationDirectory, ConversationMetadataStore } from './conversationMetadata.js';
import { conversationSecretRef, extractConversationSecrets, withoutConversationSecrets } from './conversationSecrets.js';
import { EventService, type AgentFactory, type EventServiceOptions } from './eventService.js';
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
  readonly agentFactory?: AgentFactory;
  readonly persistenceDir?: string;
  readonly secretStore?: SecretStore;
  readonly ownerInstanceId?: string;
  readonly leaseTtlMs?: number;
}

interface ClaimedLease {
  readonly lease: ConversationLease;
  readonly generation: number;
  readonly renewTimer: ReturnType<typeof setInterval>;
}

export class ConversationService {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly eventServices = new Map<string, EventService>();
  private readonly leases = new Map<string, ClaimedLease>();
  private readonly metadataStore: ConversationMetadataStore;
  private readonly readyPromise: Promise<void>;
  private readonly ownerInstanceId: string;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: ConversationServiceOptions = {}) {
    this.metadataStore = new ConversationMetadataStore(options.persistenceDir ?? 'workspace/conversations');
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? defaultLeaseTtlMs;
    this.readyPromise = this.loadPersistedConversations();
  }

  async startConversation(requestInput: StartConversationRequest): Promise<{ readonly info: ConversationInfo; readonly isNew: boolean }> {
    await this.readyPromise;
    const request = startConversationRequestSchema.parse({
      ...requestInput,
      ...((requestInput.persistence_dir === undefined || requestInput.persistence_dir === null || requestInput.persistence_dir === 'workspace/conversations') && this.options.persistenceDir !== undefined ? { persistence_dir: this.options.persistenceDir } : {}),
    });
    const id = request.id ?? request.conversation_id ?? randomUUID();
    const existing = this.conversations.get(id);
    if (existing !== undefined) {
      return { info: this.toConversationInfo(existing), isNew: false };
    }

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
    try {
      if (initialSecrets.size > 0) {
        await this.storeSecrets(id, initialSecrets);
      }
      const eventService = new EventService(this.eventServiceOptions(stored));
      this.conversations.set(id, stored);
      this.eventServices.set(id, eventService);
      await this.saveOwnedConversation(stored);

      if (sanitizedRequest.initial_message !== undefined) {
        await this.sendInitialMessage(eventService, sanitizedRequest.initial_message);
      }

      return { info: this.toConversationInfo(stored), isNew: true };
    } catch (error) {
      await this.releaseLease(id);
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
    try {
      await this.copySecrets(source.id, stored.id, stored.secret_names);
      const eventService = new EventService(this.eventServiceOptions(stored, sourceService.state.events));
      this.conversations.set(id, stored);
      this.eventServices.set(id, eventService);
      await this.saveOwnedConversation(stored);
      return this.toConversationInfo(stored);
    } catch (error) {
      await this.releaseLease(id);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.readyPromise;
    await Promise.all([...this.eventServices.values()].map((service) => service.close()));
    await Promise.all([...this.leases.keys()].map((conversationId) => this.releaseLease(conversationId)));
    this.eventServices.clear();
    this.conversations.clear();
  }

  toConversationInfo(stored: StoredConversation): ConversationInfo {
    const eventService = this.eventServices.get(stored.id);
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
      stats: {},
      secret_registry: Object.fromEntries(stored.secret_names.map((name) => [name, { source: 'keychain', ref: conversationSecretRef(stored.id, name) }])),
      agent_state: {},
      hook_config: null,
      title: stored.title,
      metrics: null,
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      tags: stored.tags,
      current_model_id: null,
      available_models: [],
      supports_runtime_model_switch: false,
      launched_agent_profile: stored.request.llm_profile_snapshot ?? null,
      agent: stored.request.agent,
      client_tools: [],
    };
  }

  private async loadPersistedConversations(): Promise<void> {
    const persisted = await this.metadataStore.loadAll();
    for (const stored of persisted) {
      if (this.conversations.has(stored.id)) continue;
      try {
        await this.claimLease(stored);
      } catch (error) {
        if (error instanceof ConversationLeaseHeldError) continue;
        throw error;
      }
      this.conversations.set(stored.id, stored);
      this.eventServices.set(stored.id, new EventService(this.eventServiceOptions(stored)));
    }
  }

  private eventServiceOptions(stored: StoredConversation, events?: readonly Event[]): EventServiceOptions {
    return {
      stored,
      saveConversation: (conversation) => this.saveOwnedConversation(conversation),
      ...(this.options.agentFactory === undefined ? {} : { agentFactory: this.options.agentFactory }),
      ...(events === undefined ? {} : { events }),
      ...(this.options.secretStore === undefined ? {} : { secretStore: this.options.secretStore }),
    };
  }


  private async saveOwnedConversation(stored: StoredConversation): Promise<void> {
    const claimed = this.leases.get(stored.id);
    if (claimed === undefined) {
      throw new Error(`conversation ${stored.id} is not owned by this server instance`);
    }
    await claimed.lease.guardedWrite(claimed.generation, () => this.metadataStore.saveConversation(stored));
  }

  private async claimLease(stored: StoredConversation): Promise<void> {
    if (this.leases.has(stored.id)) return;
    const lease = new ConversationLease(conversationDirectory(stored, this.metadataStore.defaultRoot), this.ownerInstanceId, this.leaseTtlMs);
    const claim = await lease.claim();
    const renewEveryMs = Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    const renewTimer = setInterval(() => {
      void lease.renew(claim.generation).catch((error: unknown) => {
        console.error('conversation_lease_renew_error', error);
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



  private async sendInitialMessage(eventService: EventService, request: SendMessageRequest): Promise<void> {
    await eventService.sendMessage(messageFromSendRequest(request), request.run);
  }
}

function sortConversations(items: readonly ConversationInfo[], sortOrder: ConversationSortOrder): ConversationInfo[] {
  return [...items].sort((left, right) => {
    const field = sortOrder === 'CREATED_AT' || sortOrder === 'CREATED_AT_DESC' ? 'created_at' : 'updated_at';
    const direction = sortOrder.endsWith('_DESC') ? -1 : 1;
    return direction * left[field].localeCompare(right[field]);
  });
}

