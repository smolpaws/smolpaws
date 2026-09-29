import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/jev.ts', import.meta.url));
const question = { q: { type: 'noul', instructions: 'Is a reply needed?' } };

function run(args: string[], home: string, mock: string) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', '--import', `data:text/javascript,${encodeURIComponent(mock)}`, script, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, TYPESAFE_API_KEY: 'synthetic-test-key', SMOLPAWS_HOME_DIR: home },
  });
}

test('CLI accepts file/positional requests and logs metadata without state or credentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-cli-'));
  try {
    const state = 'synthetic request payload';
    const fixture = join(home, 'request.json');
    writeFileSync(fixture, JSON.stringify({ state, questions: question }));
    const mock = `globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.state !== ${JSON.stringify(state)} || request.questions.q.type !== 'noul') throw new Error('Wrong request');
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 4 } }));
    };`;
    for (const args of [['--file', fixture, '--json'], ['--json', state, JSON.stringify(question)]]) {
      const result = run(args, home, mock);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).answers.q.noul, 0.8);
    }
    const log = join(home, 'jev/calls.jsonl');
    const text = readFileSync(log, 'utf8');
    assert.equal(text.trim().split('\n').length, 2);
    assert.ok(!text.includes(state));
    assert.ok(!text.includes('synthetic-test-key'));
    assert.equal(statSync(log).mode & 0o777, 0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI help and invalid input never call the provider or expose malformed JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-cli-'));
  const noFetch = 'globalThis.fetch = () => { throw new Error("UNEXPECTED PROVIDER CALL"); };';
  try {
    const help = run(['--help'], home, noFetch);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    for (const args of [['hello'], ['hello', '{"private fragment'], ['hello', '{}'], ['--file']]) {
      const result = run(args, home, noFetch);
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes('UNEXPECTED PROVIDER CALL'));
      assert.ok(!result.stderr.includes('private fragment'));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
