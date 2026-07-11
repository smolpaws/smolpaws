import { randomUUID } from 'node:crypto';

import {
  Agent,
  ConversationState,
  EventLog,
  EVENTS_DIR,
  LocalConversation,
  LocalFileStore,
  conversationStateUpdateEventSchema,
  interruptEventSchema,
  llmProfileSchema,
  messageEventSchema,
  pauseEventSchema,
  type Event,
  type LLMClient,
  type Message,
} from '@smolpaws/openhands-agent';

import { resolvePersistenceRoot } from './conversationMetadata.js';
import { type ConfirmationResponseRequest, type EventPage, type EventSortOrder, textFromContent } from './models.js';
import type { StoredConversation } from './models.js';
import { PubSub, type Subscriber } from './pubSub.js';

export interface AgentFactoryContext {
  readonly stored: StoredConversation;
}

export type AgentFactory = (requestAgent: unknown, context: AgentFactoryContext) => Agent | Promise<Agent>;

export interface EventServiceOptions {
  readonly stored: StoredConversation;
  readonly agentFactory?: AgentFactory;
  readonly events?: readonly Event[];
  readonly eventLog?: EventLog;
  readonly saveConversation?: (stored: StoredConversation) => Promise<void>;
}

export class EventService {
  readonly stored: StoredConversation;
  readonly eventLog: EventLog;
  readonly state: ConversationState;
  private readonly pubSub = new PubSub<Event>(50);
  private readonly saveConversation: (stored: StoredConversation) => Promise<void>;
  private readonly conversationPromise: Promise<LocalConversation>;
  private readonly publishedEventIds = new Set<string>();
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;

  constructor(options: EventServiceOptions) {
    this.stored = options.stored;
    this.eventLog = options.eventLog ?? createEventLog(options.stored);
    this.state = new ConversationState({ eventLog: this.eventLog, events: options.events ?? [] });
    this.saveConversation = options.saveConversation ?? (async () => undefined);
    this.conversationPromise = this.createConversation(options.agentFactory);
  }

  async getEvent(eventId: string): Promise<Event | null> {
    return this.events().find((event) => event.id === eventId) ?? null;
  }

  async batchGetEvents(eventIds: readonly string[]): Promise<Array<Event | null>> {
    const events = this.events();
    return eventIds.map((eventId) => events.find((event) => event.id === eventId) ?? null);
  }

  async searchEvents(
    pageId: string | null = null,
    limit = 100,
    kind: string | null = null,
    source: string | null = null,
    body: string | null = null,
    sortOrder: EventSortOrder = 'TIMESTAMP',
    timestampGte: Date | null = null,
    timestampLt: Date | null = null,
  ): Promise<EventPage> {
    const filtered = this.filteredEvents(kind, source, body, timestampGte, timestampLt);
    const ordered = sortOrder === 'TIMESTAMP_DESC' ? [...filtered].reverse() : filtered;
    const parsedPageId = pageId === null ? 0 : Number.parseInt(pageId, 10);
    const start = Number.isNaN(parsedPageId) ? 0 : Math.max(0, parsedPageId);
    const items = ordered.slice(start, start + limit);
    const next_page_id = start + limit < ordered.length ? String(start + limit) : null;
    return { items, next_page_id };
  }

  async countEvents(
    kind: string | null = null,
    source: string | null = null,
    body: string | null = null,
    timestampGte: Date | null = null,
    timestampLt: Date | null = null,
  ): Promise<number> {
    return this.filteredEvents(kind, source, body, timestampGte, timestampLt).length;
  }

  async sendMessage(message: Message, run = true): Promise<Event> {
    const event = messageEventSchema.parse({ source: message.role === 'user' ? 'user' : 'agent', llm_message: message });
    await this.appendAndPublish(event);
    if (run) {
      try {
        await this.run();
      } catch (error) {
        if (!isConversationAlreadyRunning(error)) throw error;
        this.rerunRequested = true;
      }
    }
    return event;
  }

  async subscribeToEvents(subscriber: Subscriber<Event>): Promise<string> {
    const id = this.pubSub.subscribe(subscriber);
    const stateEvent = this.createStateUpdateEvent();
    queueMicrotask(() => {
      void Promise.resolve(subscriber(stateEvent)).catch((error: unknown) => {
        console.error('initial_state_publish_error', error);
      });
    });
    return id;
  }

  async unsubscribeFromEvents(subscriberId: string): Promise<boolean> {
    return this.pubSub.unsubscribe(subscriberId);
  }

  async run(): Promise<void> {
    if (this.runPromise !== null) {
      throw new Error('conversation_already_running');
    }
    this.runPromise = this.runAndPublish();
    try {
      await this.runPromise;
    } finally {
      this.runPromise = null;
    }
  }

  async pause(): Promise<void> {
    const conversation = await this.conversationPromise;
    conversation.pause();
    await this.appendAndPublish(pauseEventSchema.parse({}));
  }

  async interrupt(): Promise<void> {
    await this.pause();
    await this.appendAndPublish(interruptEventSchema.parse({}));
  }

  async respondToConfirmation(_request: ConfirmationResponseRequest): Promise<void> {
    throw new Error('accepted_deviation:confirmation_responses');
  }

  async updateSecrets(_secrets: Record<string, unknown>): Promise<void> {
    throw new Error('conversation_secrets_not_implemented');
  }

  async setConfirmationPolicy(_policy: unknown): Promise<void> {
    throw new Error('accepted_deviation:confirmation_policy');
  }

  async setSecurityAnalyzer(_securityAnalyzer: unknown): Promise<void> {
    throw new Error('accepted_deviation:security_analyzer');
  }

  async switchAcpModel(_model: string): Promise<void> {
    throw new Error('acp_runtime_not_ported');
  }

  async generateTitle(maxLength = 50): Promise<string> {
    const firstUserMessage = this.events().find((event) => event.kind === 'MessageEvent' && event.llm_message.role === 'user');
    if (firstUserMessage?.kind !== 'MessageEvent') {
      return 'New conversation';
    }
    const text = textFromContent(firstUserMessage.llm_message.content).replace(/\s+/gu, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text || 'New conversation';
  }

  async askAgent(_question: string): Promise<string> {
    throw new Error('ask_agent_not_implemented');
  }

  async condense(): Promise<void> {
    throw new Error('condense_not_implemented');
  }

  async getAgentFinalResponse(): Promise<string> {
    const events = this.events();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind === 'MessageEvent' && event.llm_message.role === 'assistant') {
        return textFromContent(event.llm_message.content);
      }
      if (event?.kind === 'ObservationEvent' && event.tool_name === 'finish') {
        const message = event.observation.message ?? event.observation.text;
        if (typeof message === 'string') {
          return message;
        }
      }
    }
    return '';
  }

  async close(): Promise<void> {
    await this.pubSub.close();
  }

  private async createConversation(agentFactory: AgentFactory | undefined): Promise<LocalConversation> {
    const agent = agentFactory === undefined ? defaultUnconfiguredAgent() : await agentFactory(this.stored.request.agent, { stored: this.stored });
    return new LocalConversation({
      agent,
      state: this.state,
      maxIterations: this.stored.request.max_iterations,
      stuckDetection: this.stored.request.stuck_detection,
    });
  }

  private async runAndPublish(): Promise<void> {
    const conversation = await this.conversationPromise;
    do {
      this.rerunRequested = false;
      const startIndex = this.events().length;
      await conversation.run();
      this.touch();
      await this.saveConversation(this.stored);
      const newEvents = this.events().slice(startIndex);
      for (const event of newEvents) {
        await this.publishEventOnce(event);
      }
      await this.pubSub.publish(this.createStateUpdateEvent());
    } while (this.rerunRequested);
  }

  private async appendAndPublish(event: Event): Promise<void> {
    this.state.appendEvent(event);
    this.touch();
    await this.saveConversation(this.stored);
    await this.publishEventOnce(event);
  }

  private async publishEventOnce(event: Event): Promise<void> {
    if (this.publishedEventIds.has(event.id)) return;
    this.publishedEventIds.add(event.id);
    await this.pubSub.publish(event);
  }

  private filteredEvents(kind: string | null, source: string | null, body: string | null, timestampGte: Date | null, timestampLt: Date | null): Event[] {
    const bodyNeedle = body?.toLowerCase() ?? null;
    return this.events().filter((event) => {
      if (kind !== null && event.kind !== kind && !kind.endsWith(`.${event.kind}`)) {
        return false;
      }
      if (source !== null && event.source !== source) {
        return false;
      }
      const timestamp = Date.parse(event.timestamp);
      if (timestampGte !== null && timestamp < timestampGte.getTime()) {
        return false;
      }
      if (timestampLt !== null && timestamp >= timestampLt.getTime()) {
        return false;
      }
      if (bodyNeedle !== null && !eventBody(event).toLowerCase().includes(bodyNeedle)) {
        return false;
      }
      return true;
    });
  }

  private events(): Event[] {
    this.state.syncFromDisk();
    return this.state.events;
  }

  private createStateUpdateEvent(): Event {
    return conversationStateUpdateEventSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'environment',
      key: 'full_state',
      value: { execution_status: this.state.executionStatus },
    });
  }

  private touch(): void {
    this.stored.updated_at = new Date().toISOString();
  }
}

function createEventLog(stored: StoredConversation): EventLog {
  const root = resolvePersistenceRoot(stored.request.persistence_dir, 'workspace/conversations');
  return new EventLog(new LocalFileStore(root), conversationEventDir(stored.id));
}

function conversationEventDir(conversationId: string): string {
  const safeConversationId = conversationId.replace(/^\/+|\/+$/gu, '');
  if (safeConversationId.length === 0 || safeConversationId.includes('..')) {
    throw new Error(`Invalid conversationId: ${conversationId}`);
  }
  return `${safeConversationId}/${EVENTS_DIR}`;
}

function isConversationAlreadyRunning(error: unknown): boolean {
  return error instanceof Error && error.message === 'conversation_already_running';
}

function eventBody(event: Event): string {
  if (event.kind === 'MessageEvent') {
    return textFromContent(event.llm_message.content);
  }
  if (event.kind === 'ActionEvent') {
    return JSON.stringify(event.action);
  }
  if (event.kind === 'ObservationEvent') {
    return JSON.stringify(event.observation);
  }
  return JSON.stringify(event);
}

function defaultUnconfiguredAgent(): Agent {
  const llm: LLMClient = {
    profile: llmProfileSchema.parse({ profileId: 'unconfigured', providerId: 'unconfigured', model: 'unconfigured' }),
    async complete() {
      throw new Error('agent_factory_required_for_run');
    },
  };
  return new Agent({ llm });
}
