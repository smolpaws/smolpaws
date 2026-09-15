import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('product startup reuses only a product host and bootstraps the supervisor when unavailable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-launcher-'));
  const marker = path.join(root, 'started');
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  // Only the child launch is substituted; the shell and HTTP health handshake are real.
  writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nprintf "%s\\n" "$*" "$OPENHANDS_AGENT_SERVER_PORT" > "$TEST_STARTED"\n');
  chmodSync(path.join(bin, 'node'), 0o755);
  let mode: 'product' | 'bare' | 'starting' = 'product';
  const server = createServer((_req, res) => {
    if (mode === 'starting' && !existsSync(marker)) res.statusCode = 503;
    else if (mode !== 'bare') res.setHeader('x-smolpaws-host', 'relay');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn('bash', ['-c', 'set -euo pipefail; source "$ROOT_DIR/scripts/lib/product-server.sh"; ensure_smolpaws_product_server "$TEST_URL"'], {
      env: { ...process.env, ROOT_DIR: process.cwd(), SMOLPAWS_HOME_DIR: root, PERSISTENCE_DIR: path.join(root, 'conversations'),
        PATH: `${bin}:${process.env.PATH}`, TEST_STARTED: marker, TEST_URL: url },
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
  try {
    assert.equal((await run()).code, 0);
    assert.equal(existsSync(marker), false, 'healthy product host must be reused');
    mode = 'bare';
    const bare = await run(); assert.notEqual(bare.code, 0); assert.match(bare.output, /not the SmolPaws product server/);
    assert.equal(existsSync(marker), false, 'bare host must not trigger a competing process');
    mode = 'starting';
    const started = await run(); assert.equal(started.code, 0, started.output);
    const args = readFileSync(marker, 'utf8'); assert.match(args, /apps\/relay-server\/src\/supervise\.ts/);
    assert.ok(args.includes(String(address.port)));
    assert.doesNotMatch(args, /dev:server/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});
