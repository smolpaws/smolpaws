import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('rejects a legacy PATH batch shim and reaches verified download fallback', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'impeccable-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'skill scripts');
  const tools = path.join(root, 'legacy cli');
  mkdirSync(scripts);
  mkdirSync(tools);
  const launcher = path.join(scripts, 'impeccable.cmd');
  copyFileSync(new URL('../scripts/impeccable.cmd', import.meta.url), launcher);
  writeFileSync(path.join(scripts, 'VERSION'), '0.0.0-test\r\n');
  writeFileSync(path.join(tools, 'impeccable.cmd'), '@echo off\r\necho Unknown command\r\nexit /b 1\r\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    // The checksum refusal proves fallback ran without executing a downloaded binary.
    res.writeHead(req.url.endsWith('.sha256') ? 404 : 200);
    res.end('unverified test payload');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${launcher}" engine-probe"`], {
      cwd: root,
      env: {
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATH: `${tools};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
        TEMP: root, TMP: root, USERPROFILE: root, PROCESSOR_ARCHITECTURE: 'AMD64',
        IMPECCABLE_HOME: path.join(root, 'cache'),
        IMPECCABLE_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}`,
      },
      windowsVerbatimArguments: true,
      timeout: 20000,
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 127, result.stderr);
  assert.match(result.stderr, /cannot verify/);
  assert(requests.some(url => url.endsWith('/impeccable-windows-x64.exe')));
  assert(requests.some(url => url.endsWith('/impeccable-windows-x64.exe.sha256')));
});
