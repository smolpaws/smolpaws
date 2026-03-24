import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  WHATSAPP_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
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

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

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

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  // The control scope responds to ambient messages; all others require the trigger prefix.
  if (!shouldRespondWithoutTrigger(group.folder) && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  await setTyping(msg.chat_jid, true);
  const output = await runAgent(group, prompt, msg.chat_jid);
  await setTyping(msg.chat_jid, false);

  if (output.status === 'success') {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    if (output.result) {
      await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${output.result}`);
    }
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string) {
  const scope = scopeFromRegisteredGroup(chatJid, group);
  const conversationId = sessions[scope.scopeId];

  try {
    const output = await runAgentRuntime(scope, {
      prompt,
      conversationId,
      scopeId: scope.scopeId,
      groupFolder: scope.scopeId,
      chatJid,
      isControlScope: scope.isControlScope,
      isMain: scope.isControlScope
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
      return output;
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
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
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
      // Set up daily sync timer
      setInterval(() => {
        syncGroupMetadata().catch(err => logger.error({ err }, 'Periodic group sync failed'));
      }, GROUP_SYNC_INTERVAL_MS);
      startSchedulerLoop({
        sendMessage,
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions
      });
      startMessageLoop();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const chatJid = msg.key.remoteJid;
      if (!chatJid || chatJid === 'status@broadcast') continue;

      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
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
  loadState();
  await connectWhatsApp();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start SmolPaws');
  process.exit(1);
});
