import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/reconnectProcess.ts', import.meta.url));

for (const mode of ['recover', 'stop'] as const) {
  test(mode === 'recover'
    ? 'the bridge keeps its process alive to reconnect after a disconnect and a socket creation failure'
    : 'stopping cancels a pending reconnect and lets the bridge process exit naturally', async () => {
    // execFile gives the child no IPC handle or test-runner timer that could mask a missing timer ref.
    const { stdout, stderr } = await execFileAsync(process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), fixture, mode], { timeout: 10_000 });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      calls: mode === 'recover' ? 3 : 1,
      networkRequests: 0,
      stopped: true,
    });
  });
}
