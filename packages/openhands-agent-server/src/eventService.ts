import { randomUUID } from 'node:crypto';

import {
  Agent,
  ConversationState,
  LocalConversation,
  conversationStateUpdateEventSchema,
  interruptEventSchema,
  llmProfileSchema,
  messageEventSchema,
  pauseEventSchema,
  type Event,
  type LLMClient,
  type Message,
} from '@smolpaws/openhands-agent';

import { type ConfirmationResponseRequest, type EventPage, type EventSortOrder, textFromContent } from './models.js';
import type { StoredConversation } from './models.js';
import type { ConversationPersistence } from './persistence.js';
import { PubSub, type Subscriber } from './pubSub.js';

export interface AgentFactoryContext {
  readonly stored: StoredConversation;
}

export type AgentFactory = (requestAgent: unknown, context: AgentFactoryContext) => Agent | Promise<Agent>;

export interface EventServiceOptions {
  readonly stored: StoredConversation;
  readonly agentFactory?: AgentFactory;
  readonly events?: readonly Event[];
  readonly persistence?: ConversationPersistence;
}

export class EventService {
  readonly stored: StoredConversation;
  readonly state: ConversationState;
  private readonly pubSub = new PubSub<Event>(50);
  private readonly persistence: ConversationPersistence | undefined;
  private readonly conversationPromise: Promise<LocalConversation>;
  private runPromise: Promise<void> | null = null;

  constructor(options: EventServiceOptions) {
    this.stored = options.stored;
    this.persistence = options.persistence;
    this.state = new ConversationState({ events: options.events ?? [] });
    this.conversationPromise = this.createConversation(options.agentFactory);
  }

  async getEvent(eventId: string): Promise<Event | null> {
    return this.state.events.find((event) => event.id === eventId) ?? null;
  }

  async batchGetEvents(eventIds: readonly string[]): Promise<Array<Event | null>> {
    return eventIds.map((eventId) => this.state.events.find((event) => event.id === eventId) ?? null);
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
    const start = pageId === null ? 0 : Math.max(0, Number.parseInt(pageId, 10));
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
      await this.run();
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
    const firstUserMessage = this.state.events.find((event) => event.kind === 'MessageEvent' && event.llm_message.role === 'user');
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
    for (let index = this.state.events.length - 1; index >= 0; index -= 1) {
      const event = this.state.events[index];
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
    const startIndex = this.state.events.length;
    await conversation.run();
    this.touch();
    await this.persistence?.saveConversation(this.stored);
    const newEvents = this.state.events.slice(startIndex);
    for (const event of newEvents) {
      await this.persistence?.appendEvent(this.stored, event);
      await this.pubSub.publish(event);
    }
    await this.pubSub.publish(this.createStateUpdateEvent());
  }

  private async appendAndPublish(event: Event): Promise<void> {
    this.state.appendEvent(event);
    this.touch();
    await this.persistence?.saveConversation(this.stored);
    await this.persistence?.appendEvent(this.stored, event);
    await this.pubSub.publish(event);
  }

  private filteredEvents(kind: string | null, source: string | null, body: string | null, timestampGte: Date | null, timestampLt: Date | null): Event[] {
    const bodyNeedle = body?.toLowerCase() ?? null;
    return this.state.events.filter((event) => {
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
