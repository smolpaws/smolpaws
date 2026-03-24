/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

import { WHATSAPP_DIR } from './config.js';

const AUTH_DIR = path.join(WHATSAPP_DIR, 'auth');
const HOME_DIR = process.env.HOME || '';
const formatHomePath = (p: string) => (HOME_DIR && p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p);

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let completed = false;

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(`  To re-authenticate, delete ${formatHomePath(AUTH_DIR)}/ and run again.`);
    process.exit(0);
  }

  console.log('Starting WhatsApp authentication...\n');
  const { version } = await fetchLatestWaWebVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['SmolPaws', 'Chrome', '1.0.0'],
    version,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log(`\n✗ Logged out. Delete ${formatHomePath(AUTH_DIR)}/ and try again.`);
        process.exit(1);
      } else if (reason === DisconnectReason.restartRequired) {
        console.log('\n↻ WhatsApp requested a reconnect to finish linking. Reconnecting...');
        setTimeout(() => {
          void authenticate();
        }, 500);
        return;
      } else {
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      if (state.creds.registered && !completed) {
        completed = true;
        console.log('\n✓ Successfully authenticated with WhatsApp!');
        console.log(`  Credentials saved to ${formatHomePath(AUTH_DIR)}/`);
        console.log('  You can now start SmolPaws.\n');
        setTimeout(() => process.exit(0), 1000);
      } else if (!state.creds.registered) {
        console.log('\nConnected to WhatsApp, waiting for registration to finish...');
      }
    }
  });

  sock.ev.on('creds.update', () => {
    saveCreds();
    if (state.creds.registered && !completed) {
      completed = true;
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log(`  Credentials saved to ${formatHomePath(AUTH_DIR)}/`);
      console.log('  You can now start SmolPaws.\n');
      setTimeout(() => process.exit(0), 1000);
    }
  });
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
