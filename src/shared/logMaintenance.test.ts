import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const script = fileURLToPath(new URL('../../scripts/maintain-local-logs.py', import.meta.url));
const maxBytes = 1024;
const tailBytes = 200;

function fixture(createLogs = true) {
  const home = mkdtempSync(path.join(tmpdir(), 'smolpaws-log-maintenance-'));
  const logs = path.join(home, 'logs');
  if (createLogs) mkdirSync(logs);
  return { home, logs, log: path.join(logs, 'server.log'), archive: path.join(logs, 'server.log.tail.gz'),
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(home: string, extra: string[] = [], names = ['server.log']) {
  return spawnSync('python3', [script, '--home', home,
    ...names.flatMap(name => ['--log', name]), '--max-bytes', String(maxBytes), '--tail-bytes', String(tailBytes), ...extra],
  { encoding: 'utf8', timeout: 10_000 });
}

function successful(result: ReturnType<typeof run>) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'ordinary successful maintenance must stay quiet');
}

function retainedFiles(logs: string) {
  return readdirSync(logs).filter(name => !['.log-maintenance.lock', '.log-maintenance-status.json'].includes(name)).sort();
}

test('retention preserves the live inode and an existing append writer continues using it', () => {
  const f = fixture();
  const original = Buffer.from('old diagnostic message\n'.repeat(100));
  writeFileSync(f.log, original, { mode: 0o600 });
  const writer = openSync(f.log, 'a');
  const before = statSync(f.log);
  try {
    successful(run(f.home));
    const after = statSync(f.log);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.size, 0);
    assert.deepEqual(gunzipSync(readFileSync(f.archive)), original.subarray(-tailBytes));
    writeSync(writer, 'fresh diagnostic after retention\n');
    assert.equal(readFileSync(f.log, 'utf8'), 'fresh diagnostic after retention\n');
  } finally { closeSync(writer); f.cleanup(); }
});

test('the checkpoint retains the exact bounded binary tail and replaces its previous contents privately', () => {
  const f = fixture();
  try {
    const first = Buffer.alloc(maxBytes + 1, 0xab);
    writeFileSync(f.log, first);
    successful(run(f.home));
    assert.deepEqual(gunzipSync(readFileSync(f.archive)), first.subarray(-tailBytes));
    assert.equal(statSync(f.archive).mode & 0o777, 0o600);

    const second = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    writeFileSync(f.log, second);
    successful(run(f.home));
    assert.deepEqual(gunzipSync(readFileSync(f.archive)), second.subarray(-tailBytes));
    assert.equal(statSync(f.archive).mode & 0o777, 0o600);
    assert.deepEqual(retainedFiles(f.logs),
      ['server.log', 'server.log.tail.gz']);
  } finally { f.cleanup(); }
});

test('logs at or below the limit are unchanged and missing logs never create checkpoint files', () => {
  const f = fixture();
  try {
    for (const size of [0, maxBytes - 1, maxBytes]) {
      const original = Buffer.alloc(size, 0x41);
      writeFileSync(f.log, original);
      const before = statSync(f.log);
      successful(run(f.home));
      assert.deepEqual(readFileSync(f.log), original);
      assert.equal(statSync(f.log).ino, before.ino);
      assert.equal(existsSync(f.archive), false);
    }
    successful(run(f.home, [], ['missing.log']));
    assert.equal(existsSync(path.join(f.logs, 'missing.log')), false);
    assert.equal(existsSync(path.join(f.logs, 'missing.log.tail.gz')), false);
  } finally { f.cleanup(); }

  const missing = fixture(false);
  try {
    successful(run(missing.home, [], []));
    assert.equal(existsSync(missing.logs), false, 'an unused installation must remain untouched');
  } finally { missing.cleanup(); }
});

test('dry-run returns JSON decisions without changing logs or creating the lock or checkpoint', () => {
  const f = fixture();
  try {
    const original = Buffer.alloc(maxBytes * 4, 0x42);
    writeFileSync(f.log, original);
    const before = statSync(f.log);
    const result = run(f.home, ['--dry-run']);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), 'dry-run must describe its decision');
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.results, [{ log: 'server.log', bytes: original.length, status: 'rotate' }]);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(readFileSync(f.log), original);
    assert.equal(statSync(f.log).ino, before.ino);
    assert.equal(statSync(f.log).mtimeMs, before.mtimeMs);
    assert.deepEqual(readdirSync(f.logs), ['server.log']);
  } finally { f.cleanup(); }
});

test('default server logs and explicitly repeated log options select only their intended files', () => {
  const f = fixture();
  const defaults = ['openhands-agent-server-8790.log', 'openhands-agent-server-8790.error.log'];
  const original = Buffer.alloc(maxBytes * 2, 0x47);
  try {
    for (const name of [...defaults, 'server.log', 'other.log']) writeFileSync(path.join(f.logs, name), original);
    successful(run(f.home, [], []));
    for (const name of defaults) {
      assert.equal(statSync(path.join(f.logs, name)).size, 0);
      assert.deepEqual(gunzipSync(readFileSync(path.join(f.logs, name + '.tail.gz'))), original.subarray(-tailBytes));
    }
    assert.deepEqual(readFileSync(f.log), original);
    assert.deepEqual(readFileSync(path.join(f.logs, 'other.log')), original);
    successful(run(f.home, [], ['server.log', 'other.log']));
    assert.equal(statSync(f.log).size, 0);
    assert.equal(statSync(path.join(f.logs, 'other.log')).size, 0);
  } finally { f.cleanup(); }
});

test('replacing a checkpoint symlink never writes through it to its target', () => {
  const f = fixture();
  const external = path.join(f.home, 'external-checkpoint');
  const original = Buffer.alloc(maxBytes * 2, 0x48);
  try {
    writeFileSync(f.log, original);
    writeFileSync(external, 'private sentinel');
    symlinkSync(external, f.archive);
    successful(run(f.home));
    assert.equal(readFileSync(external, 'utf8'), 'private sentinel');
    assert.deepEqual(gunzipSync(readFileSync(f.archive)), original.subarray(-tailBytes));
    assert.equal(statSync(f.archive).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('refused active paths cannot truncate a symlink target, hardlinked file, or directory', () => {
  for (const kind of ['symlink', 'hardlink', 'directory'] as const) {
    const f = fixture();
    const external = path.join(f.home, 'external.log');
    const original = Buffer.alloc(maxBytes * 2, 0x43);
    try {
      writeFileSync(external, original);
      if (kind === 'symlink') symlinkSync(external, f.log);
      else if (kind === 'hardlink') linkSync(external, f.log);
      else mkdirSync(f.log);
      const result = run(f.home);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${kind} must be refused`);
      assert.deepEqual(readFileSync(external), original);
      assert.equal(existsSync(f.archive), false);
      if (kind === 'directory') assert.equal(statSync(f.log).isDirectory(), true);
    } finally { f.cleanup(); }
  }
});

test('unsafe log names are rejected before accessing files outside the logs directory', () => {
  const f = fixture();
  const external = path.join(f.home, 'outside.log');
  const original = Buffer.alloc(maxBytes * 2, 0x44);
  try {
    writeFileSync(external, original);
    for (const name of ['../outside.log', external, 'server.txt']) {
      const result = run(f.home, [], [name]);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${name} must be refused`);
      assert.deepEqual(readFileSync(external), original);
    }
  } finally { f.cleanup(); }
});

test('a real checkpoint replacement failure leaves the active log and inode intact', () => {
  const f = fixture();
  const original = Buffer.alloc(maxBytes * 2, 0x45);
  try {
    writeFileSync(f.log, original);
    const before = statSync(f.log);
    mkdirSync(f.archive);
    const result = run(f.home);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(f.log), original);
    assert.equal(statSync(f.log).ino, before.ino);
    assert.equal(statSync(f.archive).isDirectory(), true);
    assert.deepEqual(retainedFiles(f.logs),
      ['server.log', 'server.log.tail.gz'], 'failed checkpoint writes must not leave temporary archives');
  } finally { f.cleanup(); }
});

test('a concurrent maintenance lock makes the CLI return quietly without touching the log', async () => {
  const f = fixture();
  const original = Buffer.alloc(maxBytes * 2, 0x46);
  writeFileSync(f.log, original);
  const holder = spawn('python3', ['-c',
    'import fcntl, sys\nwith open(sys.argv[1], "a") as lock:\n fcntl.flock(lock, fcntl.LOCK_EX)\n print("locked", flush=True)\n sys.stdin.buffer.read()\n',
    path.join(f.logs, '.log-maintenance.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test lock holder did not acquire its lock')), 3000);
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.stdout.once('data', data => {
        clearTimeout(timer);
        if (String(data).trim() === 'locked') resolve();
        else reject(new Error('unexpected test lock holder output'));
      });
    });
    successful(run(f.home));
    assert.deepEqual(readFileSync(f.log), original);
    assert.equal(existsSync(f.archive), false);
  } finally {
    const exited = new Promise<void>(resolve => holder.once('close', () => resolve()));
    holder.stdin.end();
    await exited;
    f.cleanup();
  }
});
