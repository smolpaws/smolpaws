import { randomUUID } from 'node:crypto';

import { conversationExecutionStatus } from '@smolpaws/openhands-agent';

import { ConversationMetadataStore } from './conversationMetadata.js';
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
}

export class ConversationService {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly eventServices = new Map<string, EventService>();
  private readonly metadataStore: ConversationMetadataStore;
  private readonly readyPromise: Promise<void>;

  constructor(private readonly options: ConversationServiceOptions = {}) {
    this.metadataStore = new ConversationMetadataStore(options.persistenceDir ?? 'workspace/conversations');
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

    const now = new Date().toISOString();
    const stored: StoredConversation = {
      id,
      request,
      workspace: request.workspace,
      title: request.title ?? null,
      tags: request.tags,
      created_at: now,
      updated_at: now,
    };
    const eventService = new EventService(eventServiceOptions(stored, this.metadataStore, this.options.agentFactory));
    this.conversations.set(id, stored);
    this.eventServices.set(id, eventService);
    await this.metadataStore.saveConversation(stored);

    if (request.initial_message !== undefined) {
      await this.sendInitialMessage(eventService, request.initial_message);
    }

    return { info: this.toConversationInfo(stored), isNew: true };
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
    await this.metadataStore.saveConversation(stored);
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
      await this.metadataStore.saveConversation(stored);
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
      request: forkRequest,
      workspace: forkRequest.workspace,
      title: request.title ?? source.title,
      tags: request.tags ?? source.tags,
      created_at: now,
      updated_at: now,
    };
    const eventService = new EventService(eventServiceOptions(stored, this.metadataStore, this.options.agentFactory, sourceService.state.events));
    this.conversations.set(id, stored);
    this.eventServices.set(id, eventService);
    await this.metadataStore.saveConversation(stored);
    return this.toConversationInfo(stored);
  }

  async close(): Promise<void> {
    await this.readyPromise;
    await Promise.all([...this.eventServices.values()].map((service) => service.close()));
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
      secret_registry: {},
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
      launched_agent_profile: null,
      agent: stored.request.agent,
      client_tools: [],
    };
  }

  private async loadPersistedConversations(): Promise<void> {
    const persisted = await this.metadataStore.loadAll();
    for (const stored of persisted) {
      if (this.conversations.has(stored.id)) continue;
      this.conversations.set(stored.id, stored);
      this.eventServices.set(stored.id, new EventService(eventServiceOptions(stored, this.metadataStore, this.options.agentFactory)));
    }
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

function eventServiceOptions(stored: StoredConversation, metadataStore: ConversationMetadataStore, agentFactory?: AgentFactory, events?: readonly Event[]): EventServiceOptions {
  return {
    stored,
    saveConversation: (conversation) => metadataStore.saveConversation(conversation),
    ...(agentFactory === undefined ? {} : { agentFactory }),
    ...(events === undefined ? {} : { events }),
  };
}

