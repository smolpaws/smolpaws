import { importVoiceOutbox } from './voiceOutbox.js';
import type { OutboundMedia } from '../../../src/coordinator/outboundMedia.js';
/**
 * Standalone WhatsApp bridge for the durable Message Relay architecture.
 *
 * The bridge owns the Baileys socket, the channel ledger, and a small poll loop. It never runs the agent
 * itself: it durably accepts chat batches into the Message Relay, and the shared runtime integrates them
 * into the TypeScript agent-server and delivers replies through {@link WhatsAppDeliveryTarget}.
 *
 * Shape mirrors `apps/slack` (bead smolpaws-kxa): same six essentials, own process, no `/turns`.
 */
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

import Database from 'better-sqlite3';
import { markWhatsAppMessages, setWhatsAppOwnerMode } from '../../../src/whatsapp-progress.js';
import { acquireWhatsAppOwner } from '../../../src/whatsapp-owner.js';
import { isTransientNetworkError } from '../../../src/network-errors.js';
import { resolveOutboundChatJid } from '../../../src/whatsapp-jid.js';
import { resolveWhatsAppVersion } from '../../../src/whatsapp-version.js';
import { loadConfig, loadRegisteredGroups, type RegisteredGroup, type WhatsAppConfig } from './config.js';
import {
  buildPrompt,
  collapseToLatestPerChat,
  conversationDefaultsForGroup,
  laneDescriptorFor,
  shouldRespond,
} from './handler.js';
import { WhatsAppLedger, type LedgerMessage } from './ledger.js';
import { WhatsAppRelayRuntime } from './relayRuntime.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The slice of a Baileys socket the bridge touches; tests provide a fake. */
export interface WhatsAppSocketLike {
  ev: {
    on(event: 'connection.update', handler: (update: ConnectionUpdate) => void): void;
    on(event: 'creds.update', handler: () => void | Promise<void>): void;
    on(event: 'messages.upsert', handler: (upsert: { messages: WAMessage[] }) => void | Promise<void>): void;
  };
  user?: { id?: string | null; lid?: string | null } | undefined;
  sendMessage(jid: string, content: { text?: string; image?: { url: string }; video?: { url: string }; audio?: { url: string }; document?: { url: string }; mimetype?: string; ptt?: boolean; caption?: string; fileName?: string }, options?: { messageId: string }): Promise<{ key?: { id?: string | null } } | undefined>;
  sendPresenceUpdate(presence: 'composing' | 'paused', jid: string): Promise<void>;
  groupFetchAllParticipating(): Promise<Record<string, { subject?: string }>>;
  updateMediaMessage?: (message: WAMessage) => Promise<WAMessage>;
  end?: (error: Error | undefined) => void;
}

export interface ConnectionUpdate {
  connection?: 'connecting' | 'open' | 'close';
  lastDisconnect?: { error?: unknown };
  qr?: string;
}

export interface WhatsAppSocketFactory {
  (config: WhatsAppConfig, logger: Logger): Promise<{ socket: WhatsAppSocketLike; saveCreds: () => Promise<void> | void }>;
}

export interface WhatsAppBridgeOptions {
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  config?: WhatsAppConfig;
  /** Override the durable relay store (tests, isolated canaries). */
  relayDbPath?: string;
  /** Override the message ledger path (tests). */
  ledgerPath?: string;
  tickMs?: number;
  /** Shared conversation defaults (identity context, ingress tag); the per-scope workspace is added here. */
  createConversationDefaults?: Record<string, unknown>;
  controlConversationDefaults?: Record<string, unknown>;
  socketFactory?: WhatsAppSocketFactory;
  downloadMedia?: (message: WAMessage, socket: WhatsAppSocketLike, logger: Logger) => Promise<Buffer>;
  /** Send `🐾 I'm up.` to the control chat once per process start. Default true. */
  startupPing?: boolean;
  /** Called when WhatsApp needs a fresh device link. Default: log, notify, exit(1). */
  onAuthRequired?: () => void;
}

/** Default socket factory: real Baileys with the multi-file auth state under `~/.smolpaws/whatsapp/auth`. */
export const baileysSocketFactory: WhatsAppSocketFactory = async (config, logger) => {
  mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version, source } = await resolveWhatsAppVersion();
  logger.info({ version, versionSource: source }, 'Resolved WhatsApp client version');
  const socket = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['SmolPaws', 'Chrome', '1.0.0'],
    version,
  });
  return { socket: socket as unknown as WhatsAppSocketLike, saveCreds };
};

async function defaultDownloadMedia(message: WAMessage, socket: WhatsAppSocketLike, logger: Logger): Promise<Buffer> {
  return downloadMediaMessage(message, 'buffer', {}, {
    reuploadRequest: socket.updateMediaMessage ?? (async (m) => m),
    logger,
  });
}

function resolveMediaMime(message: WAMessage['message']): string | undefined {
  return (
    message?.imageMessage?.mimetype ??
    message?.videoMessage?.mimetype ??
    message?.stickerMessage?.mimetype ??
    message?.documentMessage?.mimetype ??
    message?.audioMessage?.mimetype ??
    (message?.imageMessage ? 'image/jpeg' : undefined) ??
    (message?.stickerMessage ? 'image/webp' : undefined)
  );
}

function firstText(...values: Array<string | null | undefined>): string {
  return values.find((value) => !!value) ?? '';
}

export function extractMessageText(message: WAMessage['message']): string {
  if (!message) return '';
  const direct = firstText(
    message.conversation,
    message.extendedTextMessage?.text,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
  );
  if (direct) return direct;
  return firstText(message.documentWithCaptionMessage?.message?.documentMessage?.caption);
}

export class WhatsAppBridge {
  private readonly logger: Logger;
  private readonly serverUrl: string;
  private readonly sessionApiKey: string | undefined;
  private readonly config: WhatsAppConfig;
  private readonly relayDbPath: string | undefined;
  private readonly ledgerPath: string;
  private readonly tickMs: number | undefined;
  private readonly controlDefaults: Record<string, unknown>;
  private readonly sharedDefaults: Record<string, unknown>;
  private readonly socketFactory: WhatsAppSocketFactory;
  private readonly downloadMedia: NonNullable<WhatsAppBridgeOptions['downloadMedia']>;
  private readonly startupPing: boolean;
  private readonly onAuthRequired: () => void;

  private releaseOwner: (() => void) | undefined;
  private socket: WhatsAppSocketLike | undefined;
  private ledger: WhatsAppLedger | undefined;
  private runtime: WhatsAppRelayRuntime | undefined;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private groupSyncTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  private startupNotified = false;
  /** True between Baileys `open` and `close`; gates outbound dispatch (DeliveryTarget.isReady). */
  private socketConnected = false;
  private runtimeStarted: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private registeredGroups: Record<string, RegisteredGroup>;
  private registeredGroupsMtime = 0;
  private lastGroupSync = 0;

  constructor(options: WhatsAppBridgeOptions) {
    this.logger = options.logger.child({ bridge: 'whatsapp' });
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.sessionApiKey = options.sessionApiKey;
    this.config = options.config ?? loadConfig();
    this.relayDbPath = options.relayDbPath ?? this.config.relayDbPath;
    this.ledgerPath = options.ledgerPath ?? this.config.ledgerPath;
    this.tickMs = options.tickMs;
    this.sharedDefaults = options.createConversationDefaults ?? {};
    this.controlDefaults = options.controlConversationDefaults ?? this.sharedDefaults;
    this.socketFactory = options.socketFactory ?? baileysSocketFactory;
    this.downloadMedia = options.downloadMedia ?? defaultDownloadMedia;
    this.startupPing = options.startupPing ?? this.config.startupPing ?? true;
    this.onAuthRequired = options.onAuthRequired ?? (() => this.defaultAuthRequired());
    this.registeredGroups = this.config.registeredGroups;
  }

  get connected(): boolean {
    return this.socket !== undefined && this.runtime !== undefined;
  }

  /** The WhatsApp account id (phone JID) once connected; used as the lane account id. */
  get selfJid(): string {
    const id = this.socket?.user?.id;
    return id ? id.split(':')[0]?.split('@')[0] ?? id : 'unknown';
  }

  /**
   * Connect the transport and register handlers. The relay worker (intake integration, outbox sync,
   * delivery dispatch) starts only once WhatsApp reports the socket open, so queued deliveries from a
   * previous run are never attempted against a socket that does not exist yet. `whenReady()` resolves
   * at that point.
   */
  async start(): Promise<void> {
    if (this.socket !== undefined) return;
    this.stopping = false;
    this.releaseOwner = acquireWhatsAppOwner(this.config.authDir);
    try {
      this.ledger = new WhatsAppLedger(this.ledgerPath);
      this.ledger.initializeProgress(this.config.routerStatePath);
      // Inspect persisted destinations before opening a socket (including its startup notification).
      if (this.relayDbPath && this.relayDbPath !== ':memory:' && existsSync(this.relayDbPath)) {
        let existing: Database.Database | undefined;
        try {
          existing = new Database(this.relayDbPath, { readonly: true, fileMustExist: true });
          const lanes = existing.prepare('SELECT chat_id FROM lanes WHERE platform = ?').all('whatsapp') as { chat_id: string }[];
          if (lanes.some(lane => !this.registeredGroups[lane.chat_id])) throw new Error('Relay store contains chats outside the allowlist; select a separate relay store for the canary');
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_CANTOPEN') throw error;
        } finally { existing?.close(); }
      }
      setWhatsAppOwnerMode(this.ledger.db, 'relay');
      await this.connect();
    } catch (error) { await this.stop(); throw error; }
    this.logger.info(
      {
        agentServer: this.serverUrl,
        registeredChats: Object.keys(this.registeredGroups).length,
        buildSha: process.env.SMOLPAWS_BUILD_SHA?.trim() || undefined,
      },
      'SmolPaws WhatsApp bridge is connecting; the relay starts once the socket is open 🐾',
    );
  }

  /** Resolves once the socket has opened and the relay worker is running. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  private startRuntime(): Promise<void> {
    if (this.runtimeStarted !== null) return this.runtimeStarted;
    const runtime = new WhatsAppRelayRuntime({
      logger: this.logger,
      serverUrl: this.serverUrl,
      sessionApiKey: this.sessionApiKey,
      assistantName: this.config.assistantName,
      sendText: (jid, text) => this.sendText(jid, text),
      sendMedia: (jid, media) => this.sendMedia(jid, media),
      isConnected: () => this.socketConnected,
      createConversationDefaults: this.sharedDefaults,
      createConversationDefaultsFor: (lane) => {
        const group = this.registeredGroups[lane.chatId];
        return group === undefined ? {} : this.conversationDefaultsFor(group);
      },
      ...(this.relayDbPath === undefined ? {} : { dbPath: this.relayDbPath }),
      ...(this.tickMs === undefined ? {} : { tickMs: this.tickMs }),
    });
    this.runtime = runtime;
    const lanes = Object.entries(this.registeredGroups).map(([jid, group]) => runtime.registerLane(laneDescriptorFor(this.selfJid, jid, group)));
    if (this.ledger) runtime.scheduler.importLegacy(this.ledger.db, this.ledgerPath, lanes);
    this.runtimeStarted = runtime.start().then(() => {
      if (this.stopping) return;
      this.pollTimer = setInterval(() => {
        void this.pollOnce().catch((error: unknown) => {
          this.logger.error({ err: error }, 'WhatsApp poll failed');
        });
      }, this.config.pollIntervalMs);
      this.pollTimer.unref?.();
      this.logger.info({ agentServer: this.serverUrl }, 'SmolPaws WhatsApp bridge is ready on Message Relay path 🐾');
      this.resolveReady?.();
    }).catch(async error => {
      await runtime.stop(); this.runtime = undefined; this.runtimeStarted = null; throw error;
    });
    return this.runtimeStarted;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.groupSyncTimer !== null) {
      clearInterval(this.groupSyncTimer);
      this.groupSyncTimer = null;
    }
    await this.polling?.catch(() => undefined);
    // Keep the socket usable while the relay drains an in-flight delivery, then close everything.
    await this.runtime?.stop().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Failed to stop WhatsApp relay runtime cleanly');
    });
    try {
      this.socket?.end?.(undefined);
    } catch {
      // socket already gone
    }
    this.ledger?.close();
    this.socket = undefined;
    this.socketConnected = false;
    this.runtime = undefined;
    this.runtimeStarted = null;
    this.ledger = undefined;
    this.releaseOwner?.();
    this.releaseOwner = undefined;
  }

  /** One poll: new ledger messages per registered chat become at most one relay intake per chat. */
  pollOnce(): Promise<void> {
    if (this.polling !== null) return this.polling;
    const run = this.poll().finally(() => {
      this.polling = null;
    });
    this.polling = run;
    return run;
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectionGeneration += 1;
      try { this.socket?.end?.(undefined); } catch { /* already closed */ }
      void this.connect().catch(error => {
        this.logger.warn({ err: error }, 'WhatsApp reconnect failed; retrying');
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async connect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    const { socket, saveCreds } = await this.socketFactory(this.config, this.logger);
    if (this.stopping || generation !== this.connectionGeneration) { socket.end?.(undefined); return; }
    this.socket = socket;

    socket.ev.on('creds.update', () => {
      void Promise.resolve(saveCreds()).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Failed to save WhatsApp credentials');
      });
    });

    socket.ev.on('connection.update', (update) => {
      if (this.stopping || generation !== this.connectionGeneration) return;
      if (update.qr) {
        this.onAuthRequired();
        return;
      }
      if (update.connection === 'close') {
        this.socketConnected = false;
        const reason = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;
        this.logger.info({ reason, loggedOut, stopping: this.stopping }, 'WhatsApp connection closed');
        if (this.stopping) return;
        if (loggedOut) {
          this.logger.error('WhatsApp session logged out. Re-link the device: npm --prefix apps/whatsapp run auth');
          this.onAuthRequired();
          return;
        }
        this.scheduleReconnect();
        return;
      }
      if (update.connection === 'open') {
        this.reconnectAttempt = 0;
        this.socketConnected = true;
        this.logger.info({ selfJid: this.selfJid }, 'Connected to WhatsApp');
        void this.startRuntime().catch((error: unknown) => {
          this.logger.error({ err: error }, 'Failed to start the WhatsApp relay runtime');
          this.scheduleReconnect();
        });
        void this.syncGroupMetadata().catch((error: unknown) => {
          this.logger.error({ err: error }, 'Initial group sync failed');
        });
        if (this.groupSyncTimer === null) {
          this.groupSyncTimer = setInterval(() => {
            void this.syncGroupMetadata().catch((error: unknown) => {
              this.logger.error({ err: error }, 'Periodic group sync failed');
            });
          }, GROUP_SYNC_INTERVAL_MS);
          this.groupSyncTimer.unref?.();
        }
        if (this.startupPing && !this.startupNotified) {
          this.startupNotified = true;
          const mainJid = Object.entries(this.registeredGroups).find(([, group]) => group.folder === 'main')?.[0];
          if (mainJid) {
            void this.sendText(mainJid, `${this.config.assistantName}: 🐾 I'm up.`).catch((error: unknown) => {
              this.logger.warn({ err: error }, 'Startup notification failed');
            });
          }
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        try {
          await this.ingest(message);
        } catch (error) {
          if (isTransientNetworkError(error)) {
            this.logger.warn({ err: error }, 'Transient error while ingesting a WhatsApp message');
          } else {
            this.logger.error({ err: error }, 'Failed to ingest a WhatsApp message');
          }
        }
      }
    });
  }

  /** Store an inbound message in the ledger. Content is kept only for registered chats. */
  private async ingest(message: WAMessage): Promise<void> {
    const ledger = this.ledger;
    if (ledger === undefined || !message.message) return;
    const chatJid = message.key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return;
    const timestamp = new Date(Number(message.messageTimestamp) * 1000).toISOString();
    ledger.touchChat(chatJid, timestamp);
    this.reloadRegisteredGroupsIfChanged();
    if (this.registeredGroups[chatJid] === undefined) return;

    const media = await this.downloadAndSaveMedia(message);
    const sender = message.key.participant || message.key.remoteJid || '';
    ledger.storeMessage({
      id: message.key.id || randomUUID(),
      chatJid,
      sender,
      senderName: message.pushName || sender.split('@')[0] || sender,
      content: extractMessageText(message.message),
      timestamp,
      isFromMe: message.key.fromMe || false,
      media,
    });
  }

  private async downloadAndSaveMedia(message: WAMessage): Promise<{ path: string; type: string } | undefined> {
    const socket = this.socket;
    const mime = resolveMediaMime(message.message);
    const m = message.message;
    if (socket === undefined || !mime || !m) return undefined;
    if (!m.imageMessage && !m.videoMessage && !m.stickerMessage && !m.documentMessage && !m.audioMessage) return undefined;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const buffer = await this.downloadMedia(message, socket, this.logger);
        mkdirSync(this.config.mediaDir, { recursive: true });
        const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
        const filePath = path.join(this.config.mediaDir, `${randomUUID()}.${ext}`);
        writeFileSync(filePath, buffer);
        return { path: filePath, type: mime };
      } catch (error) {
        if (isTransientNetworkError(error) && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        this.logger.warn({ err: error, attempt }, 'Failed to download media from WhatsApp');
        return undefined;
      }
    }
    return undefined;
  }

  private async poll(): Promise<void> {
    if (this.runtime) {
      try { importVoiceOutbox(path.join(this.config.whatsappDir, 'voice-outbox.jsonl'), jid => {
        const group = this.registeredGroups[jid];
        return group ? this.runtime!.registerLane(laneDescriptorFor(this.selfJid, jid, group)) : undefined;
      }); } catch (error) { this.logger.warn({ err: error }, 'Voice outbox import paused; source retained'); }
    }
    const ledger = this.ledger;
    const runtime = this.runtime;
    if (ledger === undefined || runtime === undefined || this.stopping) return;
    this.reloadRegisteredGroupsIfChanged();

    for (const [chatJid, group] of Object.entries(this.registeredGroups)) {
      try {
        await this.pollChat(chatJid, group, ledger, runtime);
      } catch (error) {
        // One chat's failure must never block the others (bead smolpaws-39y): its cursor simply does
        // not advance and the next poll retries it.
        this.logger.error({ err: error, chatJid, scope: group.folder }, 'WhatsApp chat dispatch failed; will retry');
      }
    }
  }

  private async pollChat(chatJid: string, group: RegisteredGroup, ledger: WhatsAppLedger, runtime: WhatsAppRelayRuntime): Promise<void> {
    const cursor = ledger.getDispatchSeq(chatJid);
    const fresh = ledger.getNewMessages([chatJid], cursor, this.config.assistantName);
    if (fresh.length === 0) return;
    const [latest] = collapseToLatestPerChat(fresh);
    if (latest === undefined) return;

    // Trailing-edge debounce: let a burst finish before the cat reads it as one prompt.
    if (Date.now() - Date.parse(latest.timestamp) < this.config.debounceMs) return;

    const addressed = fresh.some((message) => shouldRespond(group, message.content.trim(), this.config.triggerPattern));
    if (!addressed) {
      ledger.setDispatchSeq(chatJid, latest.seq);
      return;
    }

    const since = ledger.getLastAgentSeq(chatJid);
    const transcript = ledger.getMessagesSince(chatJid, since, this.config.assistantName);
    const batch: LedgerMessage[] = transcript.length > 0 ? transcript : fresh;
    const prompt = await buildPrompt(batch, { maxImageBytes: this.config.maxImageBytes });

    this.logger.info(
      { chatJid, scope: group.folder, messageCount: batch.length, imageCount: prompt.images.length, documentCount: prompt.documentCount },
      'Accepting WhatsApp batch into the Message Relay',
    );
    await this.setTyping(chatJid, true);
    try {
      await runtime.accept(
        laneDescriptorFor(this.selfJid, chatJid, group),
        latest.id,
        prompt.content,
      );
    } finally {
      await this.setTyping(chatJid, false);
    }
    // Only after durable acceptance: this is the ingress success boundary.
    ledger.setLastAgentSeq(chatJid, latest.seq);
    ledger.setDispatchSeq(chatJid, latest.seq);
  }

  /** Conversation defaults are per scope: the shared identity/context plus this chat's workspace. */
  conversationDefaultsFor(group: RegisteredGroup): Record<string, unknown> {
    return conversationDefaultsForGroup(group.folder === 'main' ? this.controlDefaults : this.sharedDefaults, this.config, group);
  }

  private reloadRegisteredGroupsIfChanged(): void {
    try {
      const mtime = statSync(this.config.registeredGroupsPath).mtimeMs;
      if (mtime === this.registeredGroupsMtime) return;
      this.registeredGroupsMtime = mtime;
      this.registeredGroups = loadRegisteredGroups(this.config.registeredGroupsPath);
      this.logger.info({ count: Object.keys(this.registeredGroups).length }, 'Registered WhatsApp chats loaded');
    } catch {
      // No file yet: keep whatever we had (possibly the initial config).
    }
  }

  private async syncGroupMetadata(): Promise<void> {
    const socket = this.socket;
    const ledger = this.ledger;
    if (socket === undefined || ledger === undefined) return;
    if (Date.now() - this.lastGroupSync < GROUP_SYNC_INTERVAL_MS) return;
    const groups = await socket.groupFetchAllParticipating();
    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        ledger.updateChatName(jid, metadata.subject);
        count += 1;
      }
    }
    this.lastGroupSync = Date.now();
    this.logger.info({ count }, 'WhatsApp group metadata synced');
  }

  private async setTyping(jid: string, typing: boolean): Promise<void> {
    try {
      void this.socket?.sendPresenceUpdate(typing ? 'composing' : 'paused', jid).catch(error => this.logger.debug({ err: error }, 'Typing update failed'));
    } catch (error) {
      this.logger.debug({ jid, err: error }, 'Failed to update typing status');
    }
  }

  private async sendMedia(jid: string, media: OutboundMedia): Promise<string | null> {
    if (!this.socket || !this.socketConnected) throw new Error('WhatsApp is disconnected');
    if (!this.registeredGroups[jid]) throw new Error('WhatsApp destination is not registered');
    const target = resolveOutboundChatJid(jid, this.socket.user);
    const messageId = randomUUID().replaceAll('-', '').toUpperCase();
    const identities = [...new Set([jid, target])].map(chat_jid => ({ id: messageId, chat_jid }));
    if (this.ledger) { markWhatsAppMessages(this.ledger.db, identities, 'dispatched'); markWhatsAppMessages(this.ledger.db, identities, 'seen'); }
    const sent = await this.socket.sendMessage(target, { [media.mediaType]: { url: media.path }, mimetype: media.mimeType,
      fileName: media.fileName, ...(media.caption ? { caption: `${this.config.assistantName}: ${media.caption}` } : {}),
      ...(media.voiceNote ? { ptt: true } : {}) }, { messageId });
    return sent?.key?.id ?? null;
  }

  async sendText(jid: string, text: string): Promise<string | null> {
    const socket = this.socket;
    if (socket === undefined) throw new Error('WhatsApp socket is not connected');
    if (!this.registeredGroups[jid]) throw new Error('WhatsApp destination is not registered');
    const targetJid = resolveOutboundChatJid(jid, socket.user ?? undefined);
    const sent = await socket.sendMessage(targetJid, { text });
    this.logger.info({ requestedJid: jid, targetJid, messageId: sent?.key?.id, length: text.length }, 'WhatsApp message sent');
    return sent?.key?.id ?? null;
  }

  private defaultAuthRequired(): void {
    const message = 'WhatsApp authentication required. Run: npm --prefix apps/whatsapp run auth';
    this.logger.error(message);
    exec(`osascript -e 'display notification "${message}" with title "SmolPaws" sound name "Basso"'`, () => undefined);
    setTimeout(() => process.exit(1), 1_000);
  }
}
