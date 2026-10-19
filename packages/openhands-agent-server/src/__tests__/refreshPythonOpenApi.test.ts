import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const roots: string[] = [];
const pin = 'e7cc8c27b2b234fc1c104825ad20dddf1c01fa31';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Python OpenAPI refresh shell boundary', () => {
  test('passes canonical source metadata to generation without Bash 4 readarray', async () => {
    const fixture = await setup();
    const result = fixture.run();
    expect(result.stderr).not.toContain('readarray');
    expect(result.status).toBe(0);
    expect(await readFile(fixture.calls, 'utf8')).toBe('sync --locked --dev\nrun --locked python ' + fixture.bootstrap + ' ' + fixture.generator + '\n');
    const args = (await readFile(fixture.args, 'utf8')).trim().split('\n');
    expect(args[args.indexOf('--repository') + 1]).toBe('OpenHands/software-agent-sdk');
    expect(args[args.indexOf('--commit') + 1]).toBe(pin);
    expect(args[args.indexOf('--generator') + 1]).toBe('openhands-agent-server/openhands/agent_server/openapi.py');
  });

  test('rejects malformed metadata before dependency or schema commands', async () => {
    const fixture = await setup();
    await writeFile(fixture.manifest, '{');
    expect(fixture.run().status).not.toBe(0);
    await expect(readFile(fixture.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.args, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a different checkout before dependency or schema commands', async () => {
    const fixture = await setup();
    const result = fixture.run('0'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('upstream checkout mismatch');
    await expect(readFile(fixture.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.args, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'python-openapi-shell-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package with spaces');
  const upstream = path.join(root, 'upstream with spaces');
  const bin = path.join(root, 'bin');
  const script = path.join(packageRoot, 'scripts/refresh-python-openapi.sh');
  const bootstrap = path.join(packageRoot, 'scripts/run-pinned-python-openapi.py');
  const manifest = path.join(packageRoot, 'vendor/openhands-agent/transpile/upstream.json');
  const generator = path.join(upstream, 'openhands-agent-server/openhands/agent_server/openapi.py');
  const calls = path.join(root, 'uv-calls');
  const args = path.join(root, 'canonicalizer-args');
  await Promise.all([path.dirname(script), path.dirname(manifest), path.dirname(generator), path.join(upstream, '.git'), bin]
    .map((directory) => mkdir(directory, { recursive: true })));
  await copyFile(path.resolve('scripts/refresh-python-openapi.sh'), script);
  await Promise.all([
    writeFile(bootstrap, ''), writeFile(generator, ''),
    writeFile(manifest, JSON.stringify({ repository: 'OpenHands/software-agent-sdk', commit: pin })),
    writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$REFRESH_TEST_ACTUAL_SHA"\n', { mode: 0o755 }),
    writeFile(path.join(bin, 'uv'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$REFRESH_TEST_CALLS"\n', { mode: 0o755 }),
    writeFile(path.join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$REFRESH_TEST_ARGS"\n', { mode: 0o755 }),
  ]);
  return {
    bootstrap, generator, manifest, calls, args,
    // Native macOS Bash 3 has no readarray. Disabling it on newer Bash exercises
    // the same boundary in Linux CI; only uv/git/canonicalization are stubbed.
    run: (actual = pin) => spawnSync('/bin/bash', ['-c', 'enable -n readarray 2>/dev/null || true; source "$1" "$2"', 'refresh-test', script, upstream], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, REFRESH_TEST_ACTUAL_SHA: actual, REFRESH_TEST_CALLS: calls, REFRESH_TEST_ARGS: args },
    }),
  };
}
