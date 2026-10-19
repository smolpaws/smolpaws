import { randomUUID } from 'node:crypto';

import {
  Agent,
  AgentControlledCondensationError,
  openHandsAgentSettingsSchema,
  type SecretStore,
  conversationExecutionStatus,
  ConversationState,
  EventLog,
  EVENTS_DIR,
  LocalConversation,
  LocalFileStore,
  agentErrorEventSchema,
  conversationErrorEventSchema,
  conversationStateUpdateEventSchema,
  DuplicateEventError,
  interruptEventSchema,
  llmProfileSchema,
  messageEventSchema,
  pauseEventSchema,
  type Event,
  type ObservabilityRuntime,
  type LLMClient,
  type LLMCallContext,
  type LLMProfile,
  type Message,
  type StreamingDeltaEvent,
} from '@smolpaws/openhands-agent';

import { ConversationLeaseHeldError, ConversationLeaseInvalidError, ConversationOwnershipLostError } from './conversationLease.js';
import { resolvePersistenceRoot } from './conversationMetadata.js';
import { defaultErrorLogger, safeErrorDiagnostics, safeRunError, type ErrorLogger } from './errorDiagnostics.js';
import { conversationSecretRef, extractConversationSecretUpdates } from './conversationSecrets.js';
import { type ConfirmationResponseRequest, type EventPage, type EventSortOrder, textFromContent } from './models.js';
import type { StoredConversation } from './models.js';
import { ConversationRunLimitExceeded, RunAdmission, type RunSlot } from './runAdmission.js';
import { PubSub, type Subscriber } from './pubSub.js';
import { ConversationProfileRuntime, type ProfileRuntimeOptions, type UpdateConversationRequest } from './profileRuntime.js';

export interface AgentFactoryContext {
  readonly stored: StoredConversation;
  readonly switchProfile?: (name: string, inlineProfile?: LLMProfile) => Promise<{ model: string }>;
  readonly state?: ConversationState;
  /** Available when tools execute, after LocalConversation has been constructed. */
  readonly getLLMCallContext?: () => LLMCallContext;
  /** A validated, already prepared initial replacement; never supplied by an HTTP caller. */
  readonly llmClient?: LLMClient;
  /** Atomically update server-owned configuration under the conversation ownership guard. */
  readonly updateRequest?: UpdateConversationRequest;
}

export type AgentFactory = (requestAgent: unknown, context: AgentFactoryContext) => Agent | Promise<Agent>;

export interface EventServiceOptions {
  readonly runAdmission?: RunAdmission;
  readonly observability?: ObservabilityRuntime;
  readonly stored: StoredConversation;
  readonly errorLogger?: ErrorLogger;
  readonly agentFactory?: AgentFactory;
  /** Match the factory fallback for legacy requests that omit agent settings; no client preparation. */
  readonly getDefaultAgentSettings?: () => unknown;
  readonly events?: readonly Event[];
  readonly eventLog?: EventLog;
  readonly saveConversation?: (stored: StoredConversation) => Promise<void>;
  readonly secretStore?: SecretStore;
  readonly profileRuntime?: ProfileRuntimeOptions;
  readonly updateRequest?: UpdateConversationRequest;
}

export class EventService {
  readonly stored: StoredConversation;
  readonly eventLog: EventLog;
  readonly state: ConversationState;
  private readonly pubSub = new PubSub<Event>(50, { isStreamingDelta: isStreamingDeltaEvent });
  private readonly errorLogger: ErrorLogger;
  private readonly saveConversation: (stored: StoredConversation) => Promise<void>;
  private readonly secretStore: SecretStore | undefined;
  private readonly agentFactory: AgentFactory | undefined;
  private readonly getDefaultAgentSettings: EventServiceOptions['getDefaultAgentSettings'];
  private readonly updateRequest: UpdateConversationRequest;
  private readonly maintenance = new Set<Promise<void>>();
  private closing = false;
  private readonly runAdmission: RunAdmission;
  private readonly observability: ObservabilityRuntime | undefined;
  private stopGeneration = 0;
  private capacityWaiter: AbortController | null = null;
  private conversationPromise: Promise<LocalConversation> | null = null;
  private readonly publishedEventIds = new Set<string>();
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;
  private selectionRequested = false;
  private lastStepUserMessageId: string | null = null;
  private readonly profileRuntime: ConversationProfileRuntime | undefined;

  constructor(options: EventServiceOptions) {
    this.observability = options.observability;
    this.runAdmission = options.runAdmission ?? new RunAdmission();
    this.stored = options.stored;
    this.errorLogger = options.errorLogger ?? defaultErrorLogger;
    this.eventLog = options.eventLog ?? createEventLog(options.stored);
    this.state = new ConversationState({ eventLog: this.eventLog, events: options.events ?? [] });
    this.saveConversation = options.saveConversation ?? (async () => undefined);
    this.secretStore = options.secretStore;
    this.agentFactory = options.agentFactory;
    this.getDefaultAgentSettings = options.getDefaultAgentSettings;
    this.updateRequest = options.updateRequest ?? (async (update) => {
      const request = update(this.stored.request);
      await this.saveConversation({ ...this.stored, request });
      this.stored.request = request;
    });
    this.profileRuntime = options.profileRuntime === undefined ? undefined : new ConversationProfileRuntime(
      this.stored, options.profileRuntime, this.updateRequest,
    );
  }

  /** Called only while restoring an exclusively owned conversation, before exposing it. */
  async recoverInterruptedTools(): Promise<boolean> {
    const events = this.events();
    // Python also guards by tool_call_id: an imported observation may identify
    // the completed call even when its action_id differs from the local event ID.
    const completedCalls = new Set(events.flatMap((event) =>
      event.kind === 'ObservationEvent' || event.kind === 'UserRejectObservation' || event.kind === 'AgentErrorEvent'
        ? [event.tool_call_id] : []));
    const pending = this.state.pendingActions().filter((action) => !completedCalls.has(action.tool_call_id));
    if (pending.length === 0) return false;

    this.state.executionStatus = conversationExecutionStatus.ERROR;
    for (const action of pending) {
      const error = agentErrorEventSchema.parse({
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
        error: 'A restart occurred while this tool was in progress. Its outcome is unknown because no result was saved. The tool will not be rerun automatically.',
        classification: { kind: 'internal', retryable: false },
      });
      await this.appendStateEvent(error);
      await this.publishEventOnce(error);
    }
    // The restoring owner saves metadata inside the same lease guard as these
    // event writes; calling saveConversation here would nest its lease lock.
    this.touch();
    return true;
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
        if (error instanceof ConversationRunLimitExceeded) throw new ConversationRunLimitExceeded(`Message saved. Retry POST /api/conversations/${this.stored.id}/run without resending the message.`);
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

  async run(options: { readonly runSlot?: RunSlot; readonly waitForCapacity?: boolean } = {}): Promise<void> {
    if (this.closing) throw new Error('Conversation is closing.');
    this.selectionRequested = true;
    if (this.runPromise !== null) throw new Error('conversation_already_running');
    const slot = options.runSlot?.share() ?? (options.waitForCapacity ? null : this.runAdmission.tryAcquire());
    const generation = this.stopGeneration;
    // Publish the ticket before any factory/client work can yield to another caller.
    const body = Promise.resolve().then(() => this.runAndPublish(slot, generation));
    const ticket = body.finally(() => {
      if (this.runPromise !== ticket) return;
      this.runPromise = null;
      if (!this.closing && generation === this.stopGeneration && this.needsContinuation()) {
        void this.run({ waitForCapacity: true }).catch((error: unknown) => this.logError('conversation_rerun_error', error));
      }
    });
    this.runPromise = ticket;
    void ticket.catch((error: unknown) => this.logError('conversation_run_error_cleanup', error));
  }

  private stopScheduledWork(): void {
    this.stopGeneration++;
    this.rerunRequested = false;
    this.capacityWaiter?.abort();
  }

  async pause(): Promise<void> {
    this.stopScheduledWork();
    await this.pauseInstantiatedConversation();
    await this.appendAndPublish(pauseEventSchema.parse({}));
  }

  async interrupt(): Promise<void> {
    this.stopScheduledWork();
    await this.pauseInstantiatedConversation();
    await this.appendAndPublish(pauseEventSchema.parse({}));
    await this.appendAndPublish(interruptEventSchema.parse({}));
  }

  private async pauseInstantiatedConversation(): Promise<void> {
    if (this.conversationPromise === null) return;
    const conversation = await this.conversationPromise;
    conversation.pause();
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
    if (this.closing) throw new Error('Conversation service is closing.');
    // Register before the first await, including default-setting reads and preparation.
    // SDK condense serializes with the active step; an ordinary run need not finish first.
    const operation = Promise.resolve().then(async () => {
      try { await this.rejectAgentControlledMaintenance(); } catch (error) { throw safeMaintenanceError(error); }
      this.selectionRequested = true;
      return this.condenseAndPublish();
    });
    this.maintenance.add(operation);
    try { await operation; } finally { this.maintenance.delete(operation); }
  }

  private async rejectAgentControlledMaintenance(): Promise<void> {
    let settings = this.stored.request.agent;
    if ((settings === undefined || settings === null) && this.conversationPromise === null) {
      const defaults = await this.getDefaultAgentSettings?.();
      // Another run can construct a legacy agent while defaults are loading. Its
      // cached SDK conversation, rather than later defaults, owns the active mode.
      settings = this.stored.request.agent ?? (this.conversationPromise === null ? defaults : undefined);
    }
    const configured = openHandsAgentSettingsSchema.safeParse(settings);
    if (configured.success && configured.data.condenser.enabled && configured.data.condenser.condenser_kind === 'agent_reset') {
      throw new AgentControlledCondensationError();
    }
  }

  private async condenseAndPublish(): Promise<void> {
    const startIndex = this.events().length;
    const failures: unknown[] = [];
    try {
      const conversation = await this.conversation();
      await conversation.condense();
    } catch (error) { failures.push(error); }
    this.touch();
    try { await this.saveConversation(this.stored); }
    catch (error) { failures.push(error); }
    finally {
      // Failed attempts may already have durable usage/request events. Publish them
      // once even when metadata saving fails; a maintenance call never becomes a run.
      for (const event of this.events().slice(startIndex)) await this.publishEventOnce(event);
      await this.pubSub.publish(this.createStateUpdateEvent());
    }
    // Ownership conflicts must remain HTTP 409 even when the summary failed first.
    if (failures.length > 0) throw safeMaintenanceError(failures.find(isOwnershipError) ?? failures[0]);
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
    this.closing = true;
    this.stopScheduledWork();
    await this.whenIdle();
    try { (await this.conversationPromise?.catch(() => null))?.close(); }
    finally { await this.pubSub.close(); }
  }

  /** Wait for execution and its publication/metadata cleanup, without closing subscriptions. */
  async whenIdle(): Promise<void> {
    while (this.runPromise !== null || this.maintenance.size > 0) {
      await Promise.allSettled([...(this.runPromise === null ? [] : [this.runPromise]), ...this.maintenance]);
    }
  }

  async initialize(): Promise<void> { this.selectionRequested = true; await this.conversation(); }

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
    if (this.selectionRequested) {
      this.selectionRequested = false;
      await this.profileRuntime?.observeConfiguration();
    }
    const llmClient = await this.profileRuntime?.prepareInitial(this.state);
    const runtime: { conversation?: LocalConversation } = {};
    const agent = this.agentFactory === undefined ? defaultUnconfiguredAgent() : await this.agentFactory(this.stored.request.agent, {
      stored: this.stored,
      state: this.state,
      getLLMCallContext: () => {
        if (runtime.conversation === undefined) throw new Error('Conversation call context is unavailable before construction.');
        return runtime.conversation.getLLMCallContext();
      },
      updateRequest: this.updateRequest,
      ...(this.profileRuntime === undefined ? {} : { switchProfile: (name: string, inlineProfile?: LLMProfile) => this.profileRuntime!.switchProfile(name, inlineProfile) }),
      ...(llmClient === undefined ? {} : { llmClient }),
    });
    const conversation = new LocalConversation({
      agent,
      state: this.state,
      conversationId: this.stored.id,
      userId: this.stored.request.user_id,
      tags: this.stored.tags,
      observabilityMetadata: this.stored.request.observability_metadata,
      observabilityTags: this.stored.request.observability_tags,
      observabilitySpanName: this.stored.request.observability_span_name,
      observabilityParentSpanContext: this.stored.request.observability_parent_span_context,
      observability: this.observability,
      maxIterations: this.stored.request.max_iterations,
      stuckDetection: this.stored.request.stuck_detection,
      onStepBoundary: async (currentAgent: Agent) => {
        try {
          if (this.selectionRequested) {
            this.selectionRequested = false;
            await this.profileRuntime?.observeConfiguration();
          }
          return await this.profileRuntime?.activate(currentAgent);
        } catch (error) {
          // Lease cleanup can fail after committing a replacement snapshot. Stop this run;
          // a later turn must reconstruct from durable metadata instead of reusing the old agent.
          runtime.conversation?.close();
          this.conversationPromise = null;
          throw error;
        }
      },
    });
    runtime.conversation = conversation;
    return conversation;
  }

  private needsContinuation(): boolean {
    return this.rerunRequested && this.latestUserMessageId() !== this.lastStepUserMessageId;
  }

  private async runAndPublish(initialSlot: RunSlot | null, generation: number): Promise<void> {
    let slot = initialSlot;
    try {
      do {
        if (this.closing || generation !== this.stopGeneration) break;
        if (slot === null) {
          const waiter = new AbortController();
          this.capacityWaiter = waiter;
          try { slot = await this.runAdmission.acquire(waiter.signal); }
          catch (error) { if (waiter.signal.aborted) break; throw error; }
          finally { if (this.capacityWaiter === waiter) this.capacityWaiter = null; }
        }
        if (this.closing || generation !== this.stopGeneration) break;
        this.rerunRequested = false;
        if (this.state.executionStatus === conversationExecutionStatus.FINISHED
          && this.latestUserMessageId() !== this.lastStepUserMessageId) {
          this.state.executionStatus = conversationExecutionStatus.IDLE;
        }
        const startIndex = this.events().length;
        const startedAt = Date.now();
        let failure: unknown;
        let failed = false;
        try {
          const conversation = await this.conversation();
          if (this.closing || generation !== this.stopGeneration) break;
          await conversation.run();
          this.lastStepUserMessageId = conversation.lastStepUserMessageId;
        } catch (error) { failed = true; failure = error; this.rerunRequested = false; }
        finally {
          // Release actual execution capacity before slow durable/publication tails.
          // A known unread continuation may retain this logical run-chain reservation.
          if (failed || this.closing || generation !== this.stopGeneration || !this.needsContinuation()) {
            slot.release(); slot = null;
          }
        }
        try {
          if (failed) await this.handleRunError(failure, startIndex, Date.now() - startedAt);
          else {
            this.touch();
            await this.saveConversation(this.stored);
            for (const event of this.events().slice(startIndex)) await this.publishEventOnce(event);
          }
        } finally { await this.pubSub.publish(this.createStateUpdateEvent()); }
        if (failed) { this.rerunRequested = false; break; }
      } while (this.needsContinuation());
    } finally { slot?.release(); }
  }

  private latestUserMessageId(): string | null {
    return [...this.events()].reverse().find((event) => event.kind === 'MessageEvent' && event.source === 'user')?.id ?? null;
  }

  private async handleRunError(error: unknown, startIndex: number, elapsedMs: number): Promise<void> {
    const failure = safeRunError(error);
    this.logError('conversation_run_error', error, elapsedMs);
    this.state.executionStatus = conversationExecutionStatus.ERROR;
    // Python skips ConversationRunError when its SDK already emitted an error. The TS SDK has no
    // wrapper: inspect this run's durable events, so old failures never suppress a later failure.
    if (!this.events().slice(startIndex).some((event) => event.kind === 'ConversationErrorEvent')) {
      await this.appendStateEvent(conversationErrorEventSchema.parse({ source: 'environment', ...failure }));
    }
    this.touch();
    try {
      await this.saveConversation(this.stored);
    } finally {
      // An exception must not hide the error (or earlier completed work) from live subscribers.
      for (const event of this.events().slice(startIndex)) {
        await this.publishEventOnce(event);
      }
    }
  }

  private logError(message: string, error: unknown, elapsedMs?: number): void {
    try {
      this.errorLogger.error({
        conversation_id: this.stored.id,
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
        error: safeErrorDiagnostics(error),
      }, message);
    } catch {
      // Diagnostic logging must not prevent durable errors, publication or cleanup.
    }
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
      value: { execution_status: this.state.executionStatus, stats: this.state.stats },
    });
  }

  private touch(): void {
    this.stored.updated_at = new Date().toISOString();
  }
}

function isOwnershipError(error: unknown): error is ConversationLeaseHeldError | ConversationLeaseInvalidError | ConversationOwnershipLostError {
  return error instanceof ConversationLeaseHeldError || error instanceof ConversationLeaseInvalidError || error instanceof ConversationOwnershipLostError;
}

function safeMaintenanceError(error: unknown): Error {
  // Preserve known maintenance HTTP classifications; these messages contain no credentials.
  if (isOwnershipError(error) || error instanceof AgentControlledCondensationError) return error;
  const sanitized = safeRunError(error);
  const failure = new Error(sanitized.detail);
  failure.name = sanitized.code;
  return failure;
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

function isStreamingDeltaEvent(event: Event): event is StreamingDeltaEvent {
  return event.kind === 'StreamingDeltaEvent';
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
