import { randomUUID } from 'node:crypto';

import {
  Agent,
  type SecretStore,
  conversationExecutionStatus,
  ConversationState,
  EventLog,
  EVENTS_DIR,
  LocalConversation,
  LocalFileStore,
  conversationStateUpdateEventSchema,
  DuplicateEventError,
  interruptEventSchema,
  llmProfileSchema,
  messageEventSchema,
  pauseEventSchema,
  type Event,
  type LLMClient,
  type Message,
} from '@smolpaws/openhands-agent';

import { resolvePersistenceRoot } from './conversationMetadata.js';
import { conversationSecretRef, extractConversationSecretUpdates } from './conversationSecrets.js';
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
  readonly secretStore?: SecretStore;
}

export class EventService {
  readonly stored: StoredConversation;
  readonly eventLog: EventLog;
  readonly state: ConversationState;
  private readonly pubSub = new PubSub<Event>(50);
  private readonly saveConversation: (stored: StoredConversation) => Promise<void>;
  private readonly secretStore: SecretStore | undefined;
  private readonly agentFactory: AgentFactory | undefined;
  private conversationPromise: Promise<LocalConversation> | null = null;
  private readonly publishedEventIds = new Set<string>();
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;

  constructor(options: EventServiceOptions) {
    this.stored = options.stored;
    this.eventLog = options.eventLog ?? createEventLog(options.stored);
    this.state = new ConversationState({ eventLog: this.eventLog, events: options.events ?? [] });
    this.saveConversation = options.saveConversation ?? (async () => undefined);
    this.secretStore = options.secretStore;
    this.agentFactory = options.agentFactory;
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

  async sendMessage(message: Message, run = true, eventId?: string): Promise<{ event: Event; created: boolean }> {
    // Idempotent append (additive reliability extension). When the caller supplies event_id and an event
    // with that id already exists (durable across restart via syncFromDisk), do NOT append a second copy;
    // return the existing event with created:false. A run is still (idempotently) requested below so a
    // response lost after the original append does not leave execution unrequested.
    const existing = eventId === undefined ? undefined : this.events().find((event) => event.id === eventId);
    let event: Event;
    let created: boolean;
    if (existing !== undefined) {
      event = existing;
      created = false;
    } else {
      const candidate = messageEventSchema.parse({
        ...(eventId === undefined ? {} : { id: eventId }),
        source: message.role === 'user' ? 'user' : 'agent',
        llm_message: message,
      });
      try {
        await this.appendAndPublish(candidate);
        event = candidate;
        created = true;
      } catch (error) {
        // The `.find` above and this append are not one atomic step: two concurrent requests with the
        // SAME new event_id can both miss the find and both try to append. `EventLog.append` serializes
        // and throws `DuplicateEventError` for the loser — so treat that as an idempotent replay rather
        // than a 500. Reload the now-durable event by id (`events()` calls `syncFromDisk`).
        if (!(error instanceof DuplicateEventError)) throw error;
        const durable = this.events().find((e) => e.id === candidate.id);
        if (durable === undefined) throw error; // append reported a duplicate but none is readable
        event = durable;
        created = false;
      }
    }
    if (message.role === 'user' && this.state.executionStatus !== conversationExecutionStatus.RUNNING) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
    if (run) {
      try {
        await this.run();
      } catch (error) {
        if (!isConversationAlreadyRunning(error)) throw error;
        this.rerunRequested = true;
      }
    }
    return { event, created };
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
    const runPromise = this.runAndPublish().catch((error: unknown) => this.handleRunError(error));
    this.runPromise = runPromise;
    void runPromise
      .catch((error: unknown) => {
        console.error('conversation_run_error_cleanup', error);
      })
      .finally(() => {
        this.runPromise = null;
      });
  }

  async pause(): Promise<void> {
    const conversation = await this.conversation();
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

  async updateSecrets(secrets: Record<string, unknown>): Promise<void> {
    const store = this.secretStore;
    if (store === undefined) {
      throw new Error('conversation_secret_store_not_configured');
    }
    const updates = extractConversationSecretUpdates(secrets);
    await Promise.all([
      ...[...updates.set].map(([name, value]) => store.set(conversationSecretRef(this.stored.id, name), value)),
      ...updates.delete.map((name) => store.delete(conversationSecretRef(this.stored.id, name))),
    ]);
    const names = new Set(this.stored.secret_names);
    for (const name of updates.set.keys()) names.add(name);
    for (const name of updates.delete) names.delete(name);
    this.stored.secret_names = [...names].sort();
    this.touch();
    await this.saveConversation(this.stored);
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
    await this.runPromise?.catch(() => undefined);
    await this.pubSub.close();
  }

  private conversation(): Promise<LocalConversation> {
    if (this.conversationPromise !== null) return this.conversationPromise;
    const promise = this.createConversation();
    this.conversationPromise = promise;
    void promise.catch(() => {
      if (this.conversationPromise === promise) this.conversationPromise = null;
    });
    return promise;
  }

  private async createConversation(): Promise<LocalConversation> {
    const agent = this.agentFactory === undefined ? defaultUnconfiguredAgent() : await this.agentFactory(this.stored.request.agent, { stored: this.stored });
    return new LocalConversation({
      agent,
      state: this.state,
      maxIterations: this.stored.request.max_iterations,
      stuckDetection: this.stored.request.stuck_detection,
    });
  }

  private async runAndPublish(): Promise<void> {
    const conversation = await this.conversation();
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

  private async handleRunError(error: unknown): Promise<void> {
    console.error('conversation_run_error', error);
    this.state.executionStatus = conversationExecutionStatus.ERROR;
    await this.pubSub.publish(this.createStateUpdateEvent());
  }

  private async appendAndPublish(event: Event): Promise<void> {
    await this.appendStateEvent(event);
    this.touch();
    await this.saveConversation(this.stored);
    await this.publishEventOnce(event);
  }

  private async appendStateEvent(event: Event): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        await this.state.appendEventAsync(event);
        return;
      } catch (error) {
        if (!isEventLogDeadlock(error) || Date.now() >= deadline) throw error;
        await sleep(20);
      }
    }
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

function isEventLogDeadlock(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Deadlock detected: lock already held for ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
