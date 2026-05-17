import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  WHATSAPP_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getNewMessages, getMessagesSince, updateChatName, getLastGroupSync, setLastGroupSync } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runAgentRuntime } from './agent-runtime/index.js';
import {
  isControlScope,
  shouldRespondWithoutTrigger
} from './control-scope.js';
import { scopeFromRegisteredGroup } from './scope.js';
import { loadJson, saveJson } from './utils.js';
import { collapseMessagesToLatestPerChat } from './message-loop.js';
import { ConnectionGuards } from './connection-guards.js';
import { shouldSendFinalReplyAfterOutbound } from './outbound-reply-policy.js';
import { resolveOutboundChatJid } from './whatsapp-jid.js';
import { isReadableDocumentMedia, readDocumentText } from './document-text.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MEDIA_DIR = path.join(WHATSAPP_DIR, 'media');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB cap for inline images
const require = createRequire(import.meta.url);

function resolveInstalledPackageVersion(packageName: string): string {
  let currentDir = path.dirname(require.resolve(packageName));
  while (true) {
    const manifestPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = require(manifestPath) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`package_manifest_not_found:${packageName}`);
    }
    currentDir = parentDir;
  }
}

const AGENT_SDK_VERSION = resolveInstalledPackageVersion('@smolpaws/agent-sdk');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

const guards = new ConnectionGuards();
let startupNotified = false;

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

/**
 * Sync group metadata from WhatsApp.
 * Fetches all participating groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/** Resolve MIME type from a WhatsApp message, falling back to common defaults. */
function resolveMediaMime(message: WAMessage['message']): string | undefined {
  return (
    message?.imageMessage?.mimetype ??
    message?.videoMessage?.mimetype ??
    message?.stickerMessage?.mimetype ??
    message?.documentMessage?.mimetype ??
    message?.audioMessage?.mimetype ??
    (message?.imageMessage ? 'image/jpeg' : undefined) ??
    (message?.stickerMessage ? 'image/webp' : undefined) ??
    undefined
  );
}

/** Returns true when the message carries a media type we can send to the LLM as an image. */
function isImageMedia(mime: string | undefined): boolean {
  return !!mime && mime.startsWith('image/');
}

/** Returns true when the message carries an audio file. */
function isAudioMedia(mime: string | undefined): boolean {
  return !!mime && (mime.startsWith('audio/') || mime.startsWith('application/ogg'));
}

/** Download media from a WhatsApp message and save to disk. */
async function downloadAndSaveMedia(
  msg: WAMessage,
): Promise<{ path: string; type: string } | undefined> {
  const mime = resolveMediaMime(msg.message);
  if (!mime) return undefined;

  // Only download if the message actually carries media
  const m = msg.message;
  if (!m?.imageMessage && !m?.videoMessage && !m?.stickerMessage && !m?.documentMessage && !m?.audioMessage) {
    return undefined;
  }

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      reuploadRequest: sock.updateMediaMessage,
      logger,
    });

    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
    const filename = `${crypto.randomUUID()}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    logger.debug({ filePath, mime, size: buffer.length }, 'Saved inbound media');
    return { path: filePath, type: mime };
  } catch (err) {
    logger.warn({ err }, 'Failed to download media from WhatsApp');
    return undefined;
  }
}

/** Read a saved image file and return a base64 data URL suitable for the LLM. */
function readImageAsDataUrl(mediaPath: string, mediaType: string): string | undefined {
  try {
    const buffer = fs.readFileSync(mediaPath);
    if (buffer.length > MAX_IMAGE_BYTES) {
      logger.debug({ mediaPath, size: buffer.length }, 'Image too large to inline');
      return undefined;
    }
    return `data:${mediaType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    logger.warn({ err, mediaPath }, 'Failed to read saved image');
    return undefined;
  }
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  // The control scope responds to ambient messages; all others require an @mention.
  // Images with @trigger in the caption match normally; control scope sees everything.
  if (!shouldRespondWithoutTrigger(group.folder) && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const escapeXml = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const lines: string[] = [];
  let documentCount = 0;
  for (const m of missedMessages) {
    const mediaAttr = m.media_path && isImageMedia(m.media_type) ? ' has_image="true"' : '';
    const audioAttr = m.media_path && isAudioMedia(m.media_type) ? ` has_audio="true" audio_path="${escapeXml(m.media_path)}"` : '';
    const documentAttr = m.media_path && isReadableDocumentMedia(m.media_type) ? ' has_document="true"' : '';
    let attachmentText = '';
    if (m.media_path && isReadableDocumentMedia(m.media_type)) {
      try {
        const document = await readDocumentText(m.media_path, m.media_type);
        if (document) {
          documentCount++;
          attachmentText = `\n<attachment name="${escapeXml(document.name)}" type="${escapeXml(m.media_type ?? '')}"${document.truncated ? ' truncated="true"' : ''}>${escapeXml(document.text)}</attachment>`;
        }
      } catch (err) {
        logger.warn({ err, mediaPath: m.media_path }, 'Failed to extract document text');
        attachmentText = `\n<attachment type="${escapeXml(m.media_type ?? '')}" unreadable="true"></attachment>`;
      }
    }
    lines.push(`<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttr}${audioAttr}${documentAttr}>${escapeXml(m.content)}${attachmentText}</message>`);
  }
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  // Collect image data URLs from recent messages to send to the LLM
  const imageUrls: string[] = [];
  for (const m of missedMessages) {
    if (m.media_path && m.media_type && isImageMedia(m.media_type)) {
      const dataUrl = readImageAsDataUrl(m.media_path, m.media_type);
      if (dataUrl) imageUrls.push(dataUrl);
    }
  }

  logger.info({ group: group.name, messageCount: missedMessages.length, imageCount: imageUrls.length, documentCount }, 'Processing message');

  await setTyping(msg.chat_jid, true);
  const output = await runAgent(
    group,
    prompt,
    msg.chat_jid,
    imageUrls.length > 0 ? imageUrls : undefined,
    msg.id,
  );
  await setTyping(msg.chat_jid, false);

  if (output.status === 'success') {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    if (shouldSendFinalReplyAfterOutbound(output.result, output.outboundMessages)) {
      await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${output.result}`);
    }
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageUrls?: string[],
  messageId?: string,
) {
  const scope = scopeFromRegisteredGroup(chatJid, group);
  const conversationId = sessions[scope.scopeId];

  try {
    const output = await runAgentRuntime(scope, {
      prompt,
      messageId,
      conversationId,
      scopeId: scope.scopeId,
      groupFolder: scope.scopeId,
      chatJid,
      isControlScope: scope.isControlScope,
      isMain: scope.isControlScope,
      imageUrls,
    }, {
      registeredGroups,
    });

    if (output.conversationId) {
      sessions[scope.scopeId] = output.conversationId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Agent runtime error');
      return output;
    }

    if (output.outboundMessages?.length) {
      for (const outbound of output.outboundMessages) {
        if (outbound.kind !== 'current_thread_message') {
          logger.warn({ kind: outbound.kind, group: group.name }, 'Unsupported outbound message kind');
          continue;
        }
        await sendMessage(chatJid, `${ASSISTANT_NAME}: ${outbound.text}`);
      }
    }

    return output;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error' as const,
      result: null,
      error: err instanceof Error ? err.message : String(err),
      conversationId,
    };
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  const targetJid = resolveOutboundChatJid(jid, sock.user);
  const rewritten = targetJid !== jid;

  try {
    const sent = await sock.sendMessage(targetJid, { text });
    logger.info(
      {
        requestedJid: jid,
        targetJid,
        rewritten,
        remoteJid: sent?.key?.remoteJid,
        messageId: sent?.key?.id,
        length: text.length,
      },
      'Message sent',
    );
  } catch (err) {
    logger.error({ requestedJid: jid, targetJid, rewritten, err }, 'Failed to send message');
  }
}

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(WHATSAPP_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestWaWebVersion();

  sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['SmolPaws', 'Chrome', '1.0.0'],
    version,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg = 'WhatsApp authentication required. Run: npm run auth';
      logger.error(msg);
      exec(`osascript -e 'display notification "${msg}" with title "SmolPaws" sound name "Basso"'`);
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch(err => logger.error({ err }, 'Initial group sync failed'));
      // Set up daily sync timer (replaces previous on reconnect)
      guards.replaceGroupSyncInterval(() => {
        syncGroupMetadata().catch(err => logger.error({ err }, 'Periodic group sync failed'));
      }, GROUP_SYNC_INTERVAL_MS);
      if (guards.tryStartScheduler()) {
        startSchedulerLoop({
          sendMessage,
          registeredGroups: () => registeredGroups,
          getSessions: () => sessions
        });
      }
      if (guards.tryStartMessageLoop()) {
        startMessageLoop();
      }
      // Notify the main chat once per process start
      if (!startupNotified) {
        startupNotified = true;
        const mainJid = Object.entries(registeredGroups)
          .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
        if (mainJid) {
          sendMessage(mainJid, `${ASSISTANT_NAME}: 🐾 I'm up.`)
            .catch(err => logger.warn({ err }, 'Startup notification failed'));
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const chatJid = msg.key.remoteJid;
      if (!chatJid || chatJid === 'status@broadcast') continue;

      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        // Download media if present (async, best-effort)
        let media: { path: string; type: string } | undefined;
        try {
          media = await downloadAndSaveMedia(msg);
        } catch (err) {
          logger.debug({ err }, 'Media download skipped');
        }
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, media);
      }
    }
  });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`SmolPaws running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      const pendingMessages = collapseMessagesToLatestPerChat(messages);
      if (pendingMessages.length > 0) {
        logger.info({ count: pendingMessages.length }, 'New messages');
      }
      for (const msg of pendingMessages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  logger.info({ agentSdkVersion: AGENT_SDK_VERSION }, 'Loaded @smolpaws/agent-sdk');
  loadState();
  await connectWhatsApp();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start SmolPaws');
  process.exit(1);
});
