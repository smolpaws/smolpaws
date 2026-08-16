/**
 * ADR step 3 — intake-only SHADOW path (additive, flag-gated, OFF by default).
 *
 * When `SMOLPAWS_COORD_SHADOW=1` and the ingress is a shadow-enabled channel (Slack only for now), a
 * bridge adapter ALSO forwards each incoming message to the Message-Work Coordinator, which durably
 * accepts it and appends it to the NEW upstream-shaped agent-server — in parallel to, and with zero
 * effect on, the existing `/turns` delivery path that still owns the user-facing reply.
 *
 * Hard guarantees (see BaseBridgeAdapter.emitShadowIntake):
 *   - OFF by default: with the flag unset nothing here is constructed or called.
 *   - Best-effort: {@link ShadowIntake.accept} never throws and is fire-and-forget, so a coordinator or
 *     new-server failure can never affect the real dispatch or the user.
 *   - Intake only: it accepts + appends (+ requests a run). It does NOT deliver — the old path replies.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import type { Logger } from 'pino';

import { MessageRelay } from '../coordinator/messageRelay.js';
import { HttpAgentServerClient } from '../coordinator/httpAgentServerClient.js';
import { MessageWorkStore } from '../coordinator/store.js';
import { DEFAULT_RETRY_POLICY, type InboundMessage, type IntegrationOutcome, type LaneDescriptor, type WorkRow } from '../coordinator/types.js';
import type { IncomingMessage } from './bridgeAdapter.js';

/** Channels the shadow path is allowed to run on. Slack (Liberty Labs test workspace) only, for now. */
const SHADOW_CHANNELS = new Set(['slack']);

/** True iff the shadow flag is on AND this ingress is on the allowlist. Pure given the environment. */
export function isShadowEnabled(name: string): boolean {
  return process.env.SMOLPAWS_COORD_SHADOW === '1' && SHADOW_CHANNELS.has(name);
}

/** Structural subset of {@link MessageRelay} the shadow path needs (injectable for tests). */
export interface ShadowCoordinator {
  acceptInbound(descriptor: LaneDescriptor, message: InboundMessage): Promise<WorkRow>;
  integrateNextIntake(worker: string): Promise<IntegrationOutcome>;
}

/**
 * Derive a stable coordinator {@link LaneDescriptor} for a Slack message. The Slack adapter already
 * encodes a stable per-conversation identity in `conversationId` (`slack-im-…` for DMs, `slack-thread-…`
 * for threads); we reuse that to guarantee one lane per chat/thread, and shape the ADR lane key
 * `channel:{platform}:{account}:{chat}:{thread-or-root}` from the platform context. Returns null when the
 * message lacks the fields needed to place it (the shadow path then safely skips it).
 */
export function slackLaneDescriptor(msg: IncomingMessage): LaneDescriptor | null {
  const pc = (msg.platformContext ?? {}) as Record<string, unknown>;
  const account = typeof pc.team_id === 'string' ? pc.team_id : null;
  const chat = typeof pc.channel_id === 'string' ? pc.channel_id : null;
  if (account === null || chat === null) return null;
  const isThread = msg.conversationId.startsWith('slack-thread-');
  const threadTs = typeof pc.thread_ts === 'string' ? pc.thread_ts : null;
  const threadPart = isThread ? (threadTs ?? 'root') : 'root';
  return {
    laneKey: `channel:slack:${account}:${chat}:${threadPart}`,
    platform: 'slack',
    accountId: account,
    chatId: chat,
    threadId: isThread ? threadTs : null,
    displayName: msg.conversationId,
  };
}

/**
 * Wraps a coordinator and forwards one incoming message as durable intake, then integrates it (append +
 * run) against the new server. Every path is guarded: {@link accept} resolves without throwing on any
 * error, so the caller (a fire-and-forget `void accept(...)`) is never affected.
 */
export class ShadowIntake {
  constructor(
    private readonly coordinator: ShadowCoordinator,
    private readonly logger: Logger,
  ) {}

  async accept(msg: IncomingMessage): Promise<void> {
    try {
      const descriptor = slackLaneDescriptor(msg);
      if (descriptor === null) {
        this.logger.debug({ shadow: true, conversationId: msg.conversationId }, 'shadow_intake_skipped_no_lane');
        return;
      }
      if (msg.messageId === undefined || msg.messageId === '') {
        this.logger.debug({ shadow: true, conversationId: msg.conversationId }, 'shadow_intake_skipped_no_message_id');
        return;
      }
      const inbound: InboundMessage = { sourceMessageId: msg.messageId, content: msg.prompt };
      const work = await this.coordinator.acceptInbound(descriptor, inbound);
      const outcome = await this.coordinator.integrateNextIntake('shadow');
      this.logger.info(
        {
          shadow: true,
          lane: descriptor.laneKey,
          workId: work.id,
          outcome: outcome.kind,
          eventCreated: outcome.kind === 'integrated' ? outcome.eventCreated : undefined,
        },
        'shadow_intake',
      );
    } catch (error) {
      // Best-effort: shadow failures are logged and swallowed. They must never reach the real path.
      this.logger.warn(
        { shadow: true, conversationId: msg.conversationId, err: error instanceof Error ? error.message : String(error) },
        'shadow_intake_failed',
      );
    }
  }
}

// ── Lazy shared singleton (built only when the flag is on) ──────────────────────────────────────────

let sharedInstance: ShadowIntake | null | undefined; // undefined = not attempted; null = disabled/failed
let coordinatorFactoryOverride: (() => ShadowCoordinator) | null = null;

/** Build the real coordinator from environment config (SQLite path + new-server URL/key). */
function buildRealCoordinator(): ShadowCoordinator {
  const dbPath = process.env.SMOLPAWS_COORD_DB ?? join(homedir(), '.smolpaws', 'coordinator', 'shadow.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new MessageWorkStore(new Database(dbPath), DEFAULT_RETRY_POLICY);
  const client = new HttpAgentServerClient({
    baseUrl: process.env.SMOLPAWS_COORD_SERVER_URL ?? 'http://127.0.0.1:8790',
    sessionApiKey: process.env.SMOLPAWS_COORD_SERVER_API_KEY,
  });
  return new MessageRelay(store, client);
}

/**
 * Get the process-wide shadow intake, constructing it lazily on first use. Returns null when the flag is
 * off (so nothing is constructed) or when construction fails (logged, shadow disabled for this process).
 */
export function getSharedShadowIntake(logger: Logger): ShadowIntake | null {
  if (process.env.SMOLPAWS_COORD_SHADOW !== '1') return null;
  if (sharedInstance !== undefined) return sharedInstance;
  try {
    const coordinator = coordinatorFactoryOverride !== null ? coordinatorFactoryOverride() : buildRealCoordinator();
    sharedInstance = new ShadowIntake(coordinator, logger);
  } catch (error) {
    logger.warn({ shadow: true, err: error instanceof Error ? error.message : String(error) }, 'shadow_intake_init_failed');
    sharedInstance = null;
  }
  return sharedInstance;
}

/** Test hook: override the coordinator factory (and reset the cached singleton). */
export function __setShadowCoordinatorFactoryForTests(factory: (() => ShadowCoordinator) | null): void {
  coordinatorFactoryOverride = factory;
  sharedInstance = undefined;
}

/** Test hook: clear the cached singleton and any override. */
export function __resetShadowForTests(): void {
  coordinatorFactoryOverride = null;
  sharedInstance = undefined;
}
