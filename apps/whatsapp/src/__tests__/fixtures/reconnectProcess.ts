/** Child-process fixture: no test runner or polling timer may keep this bridge alive. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { WhatsAppBridge, type ConnectionUpdate, type WhatsAppSocketLike } from '../../adapter.js';
import { loadConfig } from '../../config.js';

const root = mkdtempSync(path.join(tmpdir(), 'wa-reconnect-process-'));
process.env.SMOLPAWS_SCHEDULER_DB_PATH = path.join(root, 'scheduler.db');
let calls = 0;
let networkRequests = 0;
let stopped = false;
let connection: (update: ConnectionUpdate) => void = () => { throw new Error('Socket handler missing'); };
globalThis.fetch = async () => {
  networkRequests += 1;
  throw new Error('Network requests are forbidden in this fixture');
};
const bridge = new WhatsAppBridge({
  logger: pino({ level: 'silent' }),
  serverUrl: 'http://127.0.0.1:1',
  config: loadConfig({ SMOLPAWS_HOME_DIR: root }, root),
  startupPing: false,
  socketFactory: async () => {
    calls += 1;
    if (calls === 2) throw new Error('Transient socket creation failure');
    if (calls === 3) {
      // Once the retry succeeds, stop normally so the child can exit without process.exit().
      setImmediate(() => { void bridge.stop().then(() => { stopped = true; }); });
    }
    const socket: WhatsAppSocketLike = {
      ev: { on: ((event: string, handler: unknown) => {
        if (event === 'connection.update') connection = handler as typeof connection;
      }) as WhatsAppSocketLike['ev']['on'] },
      async sendMessage() { throw new Error('Sending is forbidden in this fixture'); },
      async sendPresenceUpdate() { throw new Error('Sending is forbidden in this fixture'); },
      async groupFetchAllParticipating() { return {}; },
      end() {},
    };
    return { socket, saveCreds() {} };
  },
});
process.on('exit', () => {
  console.log(JSON.stringify({ calls, networkRequests, stopped }));
  rmSync(root, { recursive: true, force: true });
});
await bridge.start();
connection({ connection: 'open' });
await bridge.whenReady();
connection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
if (process.argv[2] === 'stop') {
  await bridge.stop();
  stopped = true;
}
