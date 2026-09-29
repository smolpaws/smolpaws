#!/usr/bin/env -S npx tsx
/** Manual Jev evaluation. Only call metadata is logged; request state is never logged. */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { JevClient, JevError, describeAnswers, parseJevRequest } from '../src/shared/jev.js';

const help = `Usage:
  npx tsx scripts/jev.ts '<state: text or JSON>' '<questions JSON>' [--json]
  npx tsx scripts/jev.ts --file request.json [--json]

Request files contain {"state": ..., "questions": ...}.
Questions use Noul, Choice or Score, for example:
  {"urgent":{"type":"noul","instructions":"Is this urgent?"}}

Credentials: TYPESAFE_API_KEY in the environment, then macOS Keychain.
Call metadata: $SMOLPAWS_HOME_DIR/jev/calls.jsonl (default ~/.smolpaws).
Use only public/synthetic state or content approved for this hosted service.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { file: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help || process.argv.length === 2) {
    console.log(help);
    return;
  }
  let input: unknown;
  if (values.file !== undefined) {
    if (positionals.length !== 0) throw new Error('Use --file or positional state/questions, not both');
    input = JSON.parse(readFileSync(values.file, 'utf8'));
  } else {
    if (positionals.length !== 2) throw new Error('Expected state and questions JSON; see --help');
    let state: unknown;
    try { state = JSON.parse(positionals[0]); } catch { state = positionals[0]; }
    input = { state, questions: JSON.parse(positionals[1]) };
  }
  const { state, questions } = parseJevRequest(input);
  const logDir = join(process.env.SMOLPAWS_HOME_DIR || join(homedir(), '.smolpaws'), 'jev');
  const jev = new JevClient({
    onCall: record => {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(logDir, 'calls.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    },
  });
  const result = await jev.ask(state, questions, { tag: 'cli' });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(describeAnswers(result.answers) + `\n[${result.meta.ms}ms estimated $${result.meta.costUsd.toFixed(7)}]`);
}

void main().catch(error => {
  // Syntax errors may include fragments of private input; provider bodies may echo it too.
  const message = error instanceof SyntaxError ? 'Invalid JSON input' :
    error instanceof JevError ? error.message :
      error instanceof Error ? error.message : 'Jev request failed';
  console.error(message);
  process.exitCode = 1;
});
