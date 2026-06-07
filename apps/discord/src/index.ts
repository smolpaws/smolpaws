/**
 * Discord ingress — thin entry point that starts the Discord channel adapter.
 *
 * All platform logic lives in adapter.ts. This file just wires config
 * and handles process lifecycle.
 */

import pino from 'pino';
import { bridgeRegistry } from '../../../src/shared/bridgeAdapter.js';

// Import the adapter module to trigger registration with bridgeRegistry
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
    await bridgeRegistry.startAdapter('discord', {
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
    void bridgeRegistry.stopAll().finally(() => process.exit(0));
  });
}

main();
