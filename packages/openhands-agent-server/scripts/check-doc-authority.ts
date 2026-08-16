import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  'README.md',
  'TRANSPILE_RULES.md',
  'docs/ARCHITECTURE.md',
];
const errors: string[] = [];

for (const relativePath of files) {
  const content = await readFile(resolve(root, relativePath), 'utf8');
  if (content.includes('TRANSPILE_PLAN.md')) {
    errors.push(`${relativePath} refers to retired TRANSPILE_PLAN.md`);
  }
  if (relativePath === 'TRANSPILE_RULES.md') {
    if (!content.includes('vendor/openhands-agent/transpile/upstream.json')) {
      errors.push('TRANSPILE_RULES.md does not point at the vendored canonical manifest');
    }
    const literalPins = content.match(/\b[0-9a-f]{40}\b/gu) ?? [];
    if (literalPins.length > 0) {
      errors.push(`TRANSPILE_RULES.md contains literal commit SHA(s): ${literalPins.join(', ')}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Agent-server documentation authority check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('Agent-server durable docs point at vendored canonical provenance and contain no retired plan references.');
