import assert from 'node:assert/strict';
import test from 'node:test';
import { managedMentions } from '../managedAgents/mentions.js';

test('managed requests ignore quoted examples, code, escaped mentions and URL destinations', () => {
  const body = [
    '> @codex quoted request',
    '',
    '    @claude indented code',
    '',
    '```md',
    '@codex fenced example',
    '```',
    '',
    '`@claude` [reference](https://example.com/@codex)',
    '<!-- @codex -->',
    'https://example.com/?q=@claude \\@codex',
  ].join('\n');
  assert.deepEqual(managedMentions(body), []);
});

test('managed requests match handles, not longer names, and admit each provider once', () => {
  assert.deepEqual(managedMentions('@codex-example @claude2 someone@codex'), []);
  assert.deepEqual(managedMentions('@CoDeX review this, and @claude explain it. @codex'), ['codex', 'claude']);
});

test('router output cannot become another request even when it quotes a real command', () => {
  assert.deepEqual(managedMentions('<!-- github-mention-router:run:outcome -->\n@codex do it'), []);
});
