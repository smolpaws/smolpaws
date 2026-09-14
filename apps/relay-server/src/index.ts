import pino from 'pino';
import { createRelayServerApp } from './app.js';
import { RelayRuntime, defaultRelayDbPath } from '../../../src/coordinator/relayRuntime.js';
const host = process.env.OPENHANDS_AGENT_SERVER_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.OPENHANDS_AGENT_SERVER_PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
const { app } = await createRelayServerApp({ logger: true });
await app.listen({ host, port });
// Native API conversations use the same scheduler/relay, with results remaining in their EventLog.
const runtime = new RelayRuntime({ platform: 'agent-server', logger: pino(), serverUrl: `http://127.0.0.1:${port}`,
  sessionApiKey: process.env.SMOLPAWS_RELAY_SERVER_API_KEY, dbPath: defaultRelayDbPath('agent-server'),
  target: { validate() {}, async deliver() { return {}; } }, extractor: () => null });
await runtime.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void runtime.stop().then(() => app.close()).finally(() => process.exit(0));
});
