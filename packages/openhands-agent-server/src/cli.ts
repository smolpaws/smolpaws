import process from 'node:process';

import { createAgentServerApp } from './app.js';

const host = process.env.OPENHANDS_AGENT_SERVER_HOST?.trim() || '127.0.0.1';
const port = parsePort(process.env.OPENHANDS_AGENT_SERVER_PORT ?? '8790');

const { app } = await createAgentServerApp({ logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}

try {
  await app.listen({ host, port });
  app.log.info({ host, port }, 'OpenHands TypeScript agent-server listening');
} catch (error) {
  app.log.error(error);
  await app.close().catch(() => undefined);
  process.exit(1);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid OPENHANDS_AGENT_SERVER_PORT: ${value}`);
  }
  return port;
}
