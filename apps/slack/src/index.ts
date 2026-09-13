/** Standalone Slack Socket Mode entrypoint for the Message Relay/new-agent-server path. */
import pino from 'pino';

import { loadKeychainSecretsByName } from '../../../src/shared/keychain.js';
import { SlackBridge } from './adapter.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Slack tokens live in the macOS Keychain (service "openhands"), not in a
 * committed .env. Load them into process.env before the config is read, so the
 * bridge works under launchd (no login shell) without secrets on disk. Existing
 * env vars are not overwritten, so a shell that already exported them still wins.
 */
const SLACK_KEYCHAIN_SECRETS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];

let stopping = false;

function registerSignalHandlers(bridge: SlackBridge): void {
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down standalone Slack Message Relay bridge');
    await bridge.stop();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop(signal).finally(() => process.exit(process.exitCode ?? 0));
    });
  }
}

async function main(): Promise<void> {
  try {
    const loaded = await loadKeychainSecretsByName(SLACK_KEYCHAIN_SECRETS);
    if (loaded.length > 0) {
      logger.info({ loaded }, 'Loaded Slack secrets from Keychain');
    }
  } catch (error) {
    logger.warn({ error }, 'Keychain secret load failed; relying on existing env');
  }

  const agentServerUrl = (
    process.env.SMOLPAWS_RELAY_SERVER_URL ||
    process.env.SMOLPAWS_COORD_SERVER_URL ||
    'http://127.0.0.1:8790'
  ).replace(/\/+$/, '');
  const sessionKey =
    process.env.SMOLPAWS_RELAY_SERVER_API_KEY?.trim() ||
    process.env.SMOLPAWS_COORD_SERVER_API_KEY?.trim();

  const bridge = new SlackBridge({ logger, serverUrl: agentServerUrl, sessionApiKey: sessionKey });
  registerSignalHandlers(bridge);

  try {
    await bridge.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start standalone Slack Message Relay bridge');
    process.exitCode = 1;
  }
}

void main();
