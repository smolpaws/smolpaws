import { registerWebhookBridges } from './webhookBridges.js';
import { dirname } from 'node:path';
import { getDefaultConfig } from '../../../packages/openhands-agent-server/src/config.js';
import pino from 'pino';
import { createRelayServerApp } from './app.js';
import { RelayRuntime } from '../../../src/coordinator/relayRuntime.js';
import { nativeRelayDbPath } from './relayPaths.js';
const host = process.env.OPENHANDS_AGENT_SERVER_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.OPENHANDS_AGENT_SERVER_PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
const { app, scheduler } = await createRelayServerApp({ logger: true });
const sessionApiKey = getDefaultConfig().sessionApiKey;
if (sessionApiKey) registerWebhookBridges(app, { sessionApiKey, dbDirectory: dirname(nativeRelayDbPath()), schedulerDbPath: scheduler.db.name });
await app.listen({ host, port });
// Native API conversations use the same scheduler/relay, with results remaining in their EventLog.
const runtime = new RelayRuntime({ platform: 'agent-server', logger: pino(), serverUrl: `http://127.0.0.1:${port}`,
  sessionApiKey: sessionApiKey ?? undefined, dbPath: nativeRelayDbPath(), schedulerDbPath: scheduler.db.name,
  target: { validate() {}, async deliver() { return {}; } }, extractor: () => null });
await runtime.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void runtime.stop().then(() => app.close()).finally(() => process.exit(0));
});
