/**
 * Discord ingress — thin entry point that starts the Discord channel adapter.
 *
 * All platform logic lives in adapter.ts. This file just wires config
 * and handles process lifecycle.
 */

import pino from 'pino';
import { channelRegistry } from '../../../src/shared/channelAdapter.js';

// Import the adapter module to trigger registration with channelRegistry
import './adapter.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const RUNNER_URL = (
  process.env.SMOLPAWS_RUNNER_URL || 'http://127.0.0.1:8788'
).replace(/\/+$/, '');
const RUNNER_TOKEN = process.env.SMOLPAWS_RUNNER_TOKEN?.trim();

async function main() {
  try {
    await channelRegistry.startAdapter('discord', {
      runnerUrl: RUNNER_URL,
      runnerToken: RUNNER_TOKEN,
      logger,
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Discord adapter');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    void channelRegistry.stopAll().finally(() => process.exit(0));
  });
}

main();
