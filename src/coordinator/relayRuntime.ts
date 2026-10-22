import { RunRecovery } from './runRecovery.js';
/**
 * Platform-agnostic Message Relay runtime for standalone bridges.
 *
 * One bridge process = one durable SQLite store + one worker loop. The loop durably accepts platform
 * messages, integrates ready intake into the upstream-shaped agent-server, keeps the delivery outbox
 * synced from the agent EventLog, and lets {@link DeliveryDispatcher} perform the platform send through
 * the bridge's {@link DeliveryTarget}. Slack pioneered this shape (`apps/slack/src/relayRuntime.ts`);
 * WhatsApp and Discord reuse it here instead of copying it.
 *
 * Bridge-specific knowledge is injected: the platform name, the delivery target (with its transport
 * readiness), lane derivation, and optional conversation-creation defaults.
 */
import { TaskScheduler, type ScheduledLane } from './taskScheduler.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import type { Logger } from 'pino';

import { DeliveryDispatcher, DeliveryTargetRegistry, type DeliveryTarget } from './deliveryDispatcher.js';
import { HttpAgentServerClient } from './httpAgentServerClient.js';
import { deterministicConversationId } from './ids.js';
import { MessageRelay, bridgeResponseExtractor } from './messageRelay.js';
import { OutboundRelay } from './outboundRelay.js';
import { MessageWorkStore } from './store.js';
import type { DeliverableExtractor, InboundMessage, LaneDescriptor } from './types.js';

export interface RelayRuntimeOptions {
  /** Platform key stored on lanes and used to look up the delivery target, e.g. `slack`. */
  platform: string;
  /**
   * Agent-server conversation id for a new lane. Defaults to a deterministic UUIDv5 of the lane key.
   * Existing lanes keep the id stored in the relay database whatever this returns.
   */
  deriveConversationId?: (lane: LaneDescriptor) => string;
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  target: DeliveryTarget;
  /** Durable store path. Defaults to `~/.smolpaws/coordinator/<platform>-relay-v1.db`. */
  dbPath?: string;
  tickMs?: number;
  /** Extra fields used only when the relay creates a new agent-server conversation. */
  createConversationDefaults?: Record<string, unknown>;
  /** Per-lane creation fields merged over the shared defaults (for example a per-scope workspace). */
  createConversationDefaultsFor?: (lane: LaneDescriptor) => Record<string, unknown>;
  /** What counts as deliverable. Defaults to explicit sends, terminal replies, and conversation errors. */
  extractor?: DeliverableExtractor;
  maxDispatchPerTick?: number;
  schedulerDbPath?: string;
}

export interface RelayIntake {
  lane: LaneDescriptor;
  message: InboundMessage;
}

export function defaultRelayDbPath(platform: string): string {
  return process.env.SMOLPAWS_RELAY_DB_PATH?.trim() || join(process.env.SMOLPAWS_HOME_DIR?.trim() || join(homedir(), '.smolpaws'), 'coordinator', `${platform}-relay-v1.db`);
}

export class RelayRuntime {
  readonly platform: string;
  readonly scheduler: TaskScheduler;
  private readonly options: RelayRuntimeOptions;
  private readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly recovery: RunRecovery;
  private readonly agent: HttpAgentServerClient;
  private readonly store: MessageWorkStore;
  private readonly messageRelay: MessageRelay;
  private readonly outboundRelay: OutboundRelay;
  private readonly logger: Logger;
  private readonly tickMs: number;
  private readonly intakeWorker: string;
  private readonly deliveryWorker: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;
  private closed = false;

  constructor(options: RelayRuntimeOptions) {
    this.options = options;
    this.platform = options.platform;
    this.logger = options.logger.child({ component: `${options.platform}-relay-runtime` });
    this.tickMs = options.tickMs ?? 500;
    this.intakeWorker = `${options.platform}-intake:${process.pid}`;
    this.deliveryWorker = `${options.platform}-delivery:${process.pid}`;

    const dbPath = options.dbPath ?? defaultRelayDbPath(options.platform);
    this.dbPath = dbPath;
    this.scheduler = new TaskScheduler(options.schedulerDbPath ?? process.env.SMOLPAWS_SCHEDULER_DB_PATH ?? join(dirname(dbPath), 'scheduler.db'));
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.store = new MessageWorkStore(this.db);
    this.recovery = new RunRecovery(this.db);

    this.db.exec('CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.prepare("INSERT OR IGNORE INTO relay_meta VALUES ('owner', ?)").run(randomUUID());
    const owner = (this.db.prepare("SELECT value FROM relay_meta WHERE key = 'owner'").get() as { value: string }).value;
    const agent = new HttpAgentServerClient({
      conversationOwner: owner,
      baseUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      ...(options.createConversationDefaults === undefined
        ? {}
        : { createDefaults: options.createConversationDefaults }),
      ...(options.createConversationDefaultsFor === undefined
        ? { createDefaultsFor: (lane: LaneDescriptor) => this.scheduler.lane(this.store.getLane(lane.laneKey)?.conversationId ?? '')?.defaults ?? {} }
        : { createDefaultsFor: (lane) => this.scheduler.lane(this.store.getLane(lane.laneKey)?.conversationId ?? '')?.defaults ?? options.createConversationDefaultsFor!(lane) }),
    });
    this.agent = agent;
    this.messageRelay = new MessageRelay(this.store, agent, {
      onCommandError: error => this.logger.error({ err: errorMessage(error) }, 'Command outcome persistence failed; recovery will report it as unconfirmed'),
      onEvent: (conversationId, event) => { this.scheduler.observe(conversationId, event); this.recovery.observe(conversationId, event); },
      extractor: options.extractor ?? bridgeResponseExtractor,
      deriveConversationId: options.deriveConversationId ?? ((descriptor) => deterministicConversationId(descriptor.laneKey)),
    });

    const target = options.target;
    const targets = new DeliveryTargetRegistry();
    targets.register(options.platform, target);
    const dispatcher = new DeliveryDispatcher(this.store, targets);
    this.outboundRelay = new OutboundRelay(this.messageRelay, dispatcher, {
      listConversationIds: () => this.listConversationIds(),
      maxDispatchPerTick: options.maxDispatchPerTick ?? 32,
      // Sync the outbox regardless (it only reads the EventLog), but never claim delivery work while the
      // platform transport is down: queued replies wait as `ready` instead of becoming `delivery_unknown`.
      canDispatch: () => target.isReady?.() ?? true,
    });
  }

  /** Read-only access for operators and tests. */
  get workStore(): MessageWorkStore {
    return this.store;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error(`${this.platform} RelayRuntime is closed`);
    if (this.timer !== null) return;
    await this.runOnce();
    if (this.closed) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: errorMessage(error) }, 'Message Relay tick failed');
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeTick?.catch(() => undefined);
    await this.messageRelay.whenCommandsIdle();
    if (this.db.open) {
      this.db.close();
      this.scheduler.close();
    }
  }

  /**
   * Durably accept one normalized platform message and wake the worker loop. Resolves once the intake row
   * is committed, which is the ingress success boundary; the LLM run happens later on the loop.
   */
  async accept(intake: RelayIntake): Promise<void> {
    if (this.closed) throw new Error(`${this.platform} RelayRuntime is closed`);
    if (intake.message.sourceMessageId.length === 0) {
      throw new Error('Message Relay intake requires a stable sourceMessageId');
    }
    this.registerLane(intake.lane);
    await this.messageRelay.acceptInbound(intake.lane, intake.message);
    void this.runOnce().catch((error: unknown) => {
      this.logger.error({ err: errorMessage(error) }, 'Message Relay wake-up failed');
    });
  }

  registerLane(lane: LaneDescriptor, explicit?: ScheduledLane): ScheduledLane {
    const defaults = { ...this.options.createConversationDefaults, ...this.options.createConversationDefaultsFor?.(lane) };
    const conversationId = explicit?.conversationId ?? this.store.getLane(lane.laneKey)?.conversationId ?? this.options.deriveConversationId?.(lane) ?? deterministicConversationId(lane.laneKey);
    this.store.resolveLane(lane, conversationId, Date.now());
    const workspace = defaults.workspace as { working_dir?: string } | undefined;
    const tags = defaults.tags as { scope?: string } | undefined;
    const registration: ScheduledLane = explicit ?? { conversationId, lane,
      scopeId: tags?.scope ?? `${lane.platform}:${lane.accountId ?? ''}:${lane.chatId}`,
      workingDir: workspace?.working_dir ?? process.cwd(), relayDbPath: this.dbPath, defaults };
    this.scheduler.register(registration);
    return registration;
  }

  /** Exposed for deterministic tests and operational one-shot drains. Concurrent calls coalesce. */
  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.activeTick !== null) return this.activeTick;
    const tick = this.tick();
    this.activeTick = tick;
    return tick.finally(() => {
      if (this.activeTick === tick) this.activeTick = null;
    });
  }

  private async tick(): Promise<void> {
    const reconcile = this.store.reconcile(Date.now());
    for (const run of this.scheduler.due(this.platform)) {
      const registration = JSON.parse(run.lane_json) as ScheduledLane;
      // Only the process owning this relay store may submit its scheduled occurrences.
      if (registration.relayDbPath !== this.dbPath) continue;
      this.registerLane(registration.lane, registration);
      // Native group tasks append to an already-created API conversation. Isolated runs are new lanes.
      if (this.platform === 'agent-server' && registration.lane.laneKey === `agent-server:${registration.conversationId}`) {
        this.store.markLaneConversationReady(registration.lane.laneKey, Date.now());
      }
      await this.messageRelay.acceptInbound(registration.lane, { sourceMessageId: run.source_id,
        content: `[SCHEDULED TASK - automatic run]\n\n${run.prompt}` });
      this.scheduler.enqueued(run.id);
    }
    let intakeActivity = 0;

    for (let i = 0; i < 32; i += 1) {
      const outcome = await this.messageRelay.integrateNextIntake(this.intakeWorker);
      if (outcome.kind === 'idle') break;
      intakeActivity += 1;
      if (outcome.kind === 'failed' || outcome.kind === 'retry') {
        this.logger.warn({ outcome }, 'Intake integration did not complete');
      }
    }

    const outbound = await this.outboundRelay.tick(this.deliveryWorker);
    for (const failure of outbound.syncFailures) {
      this.logger.warn(
        { conversationId: failure.conversationId, err: errorMessage(failure.error) },
        'Failed to sync delivery outbox',
      );
    }
    for (const outcome of outbound.dispatchOutcomes) {
      if (outcome.kind === 'failed' || outcome.kind === 'delivery_unknown') {
        this.logger.warn({ outcome }, 'Delivery did not settle cleanly');
      }
    }

    for (const pending of this.recovery.pending()) {
      if (outbound.syncFailures.some(failure => failure.conversationId === pending.conversationId)) continue;
      try {
        const status = await this.agent.executionStatus(pending.conversationId);
        if (status === 'error' || status === 'idle' && pending.actions.length > 0) {
          const issue = status === 'error' ? 'Agent run failed; inspect before retrying' : 'Interrupted tool has no observation; reconcile its outcome before continuing';
          this.recovery.park(pending.conversationId, issue);
          this.scheduler.observe(pending.conversationId, { id: 'recovery', kind: 'ConversationErrorEvent', error: issue, reconcile_required: pending.actions.length > 0 });
          this.logger.error({ conversationId: pending.conversationId }, issue);
        } else if (status === 'idle') await this.agent.resume(pending.conversationId);
      } catch (error) { this.logger.warn({ err: errorMessage(error), conversationId: pending.conversationId }, 'Run recovery will retry'); }
    }
    const reconcileActivity =
      reconcile.expiredToReady + reconcile.expiredToDeliveryUnknown + reconcile.retryWaitToReady;
    if (
      intakeActivity > 0 ||
      outbound.syncedDeliveries > 0 ||
      outbound.dispatched > 0 ||
      reconcileActivity > 0
    ) {
      this.logger.info(
        { intakeActivity, syncedDeliveries: outbound.syncedDeliveries, dispatched: outbound.dispatched, reconcile },
        'Message Relay tick',
      );
    }
  }

  private listConversationIds(): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id FROM lanes
         WHERE platform = ? AND conversation_ready = 1
         ORDER BY last_seen_at ASC`,
      )
      .all(this.platform) as Array<{ conversation_id: string }>;
    return rows.map((row) => row.conversation_id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
