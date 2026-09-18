import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, triggerPatternFor, type RegisteredGroup } from '../config.js';
import {
  buildPrompt,
  collapseToLatestPerChat,
  conversationDefaultsForGroup,
  laneDescriptorFor,
  scopeWorkingDir,
  shouldRespond,
  splitCommandBatches,
} from '../handler.js';
import type { LedgerMessage } from '../ledger.js';

const trigger = triggerPatternFor('smolpaws');
const main: RegisteredGroup = { name: 'Engel', folder: 'main', trigger: '@smolpaws', added_at: '2026-01-01' };
const team: RegisteredGroup = { name: 'Team', folder: 'team', trigger: '@smolpaws', added_at: '2026-01-01' };
const chatty: RegisteredGroup = { ...team, folder: 'chatty', triggerFree: true };

let nextSeq = 0;

function message(overrides: Partial<LedgerMessage>): LedgerMessage {
  nextSeq += 1;
  return {
    seq: nextSeq,
    id: 'M1',
    chat_jid: '123@g.us',
    sender: '111@s.whatsapp.net',
    sender_name: 'Engel',
    content: 'hello',
    timestamp: '2026-09-13T10:00:00.000Z',
    is_from_me: 0,
    media_path: null,
    media_type: null,
    command_eligible: 1,
    ...overrides,
  };
}

test('control scope and trigger-free groups answer ambient messages; others need an @mention', () => {
  assert.equal(shouldRespond(main, 'just chatting', trigger), true);
  assert.equal(shouldRespond(chatty, 'just chatting', trigger), true);
  assert.equal(shouldRespond(team, 'just chatting', trigger), false);
  assert.equal(shouldRespond(team, 'hey @smolpaws look at this', trigger), true);
  assert.equal(shouldRespond(team, 'email@smolpaws.dev', trigger), false);
  assert.equal(shouldRespond(team, '@SmolPaws?', trigger), true);
});

test('lane identity is stable per account and chat', () => {
  const lane = laneDescriptorFor('4915551234', '123@g.us', team);
  assert.deepEqual(lane, {
    laneKey: 'whatsapp:4915551234:123@g.us',
    platform: 'whatsapp',
    accountId: '4915551234',
    chatId: '123@g.us',
    threadId: null,
    displayName: 'team (Team)',
  });
});

test('prompt is the legacy <messages> transcript with escaped content and media attributes', async () => {
  const prompt = await buildPrompt(
    [
      message({ id: 'M1', content: 'a < b & "c"' }),
      message({ id: 'M2', sender_name: 'Bob', content: 'voice', timestamp: '2026-09-13T10:00:01.000Z', media_path: '/tmp/x.ogg', media_type: 'audio/ogg' }),
    ],
    { maxImageBytes: 1024 },
  );
  assert.equal(
    prompt.text,
    '<messages>\n' +
      '<message sender="Engel" time="2026-09-13T10:00:00.000Z">a &lt; b &amp; &quot;c&quot;</message>\n' +
      '<message sender="Bob" time="2026-09-13T10:00:01.000Z" has_audio="true" audio_path="/tmp/x.ogg">voice</message>\n' +
      '</messages>',
  );
  assert.equal(prompt.content, prompt.text);
  assert.equal(prompt.images.length, 0);
});

test('inline images become a text+image content array, bounded by size', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'whatsapp-handler-'));
  const small = path.join(dir, 'small.png');
  const big = path.join(dir, 'big.png');
  writeFileSync(small, Buffer.from('tiny'));
  writeFileSync(big, Buffer.alloc(2048));
  try {
    const prompt = await buildPrompt(
      [
        message({ id: 'M1', content: 'look', media_path: small, media_type: 'image/png' }),
        message({ id: 'M2', content: 'and this', media_path: big, media_type: 'image/png', timestamp: '2026-09-13T10:00:01.000Z' }),
      ],
      { maxImageBytes: 1024 },
    );
    assert.equal(prompt.images.length, 1);
    assert.ok(prompt.text.includes('has_image="true"'));
    const content = prompt.content as Array<{ type: string; image_urls?: string[] }>;
    assert.equal(content[0]?.type, 'text');
    assert.equal(content[1]?.type, 'image');
    assert.deepEqual(content[1]?.image_urls, ['data:image/png;base64,dGlueQ==']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a burst collapses to the latest ingested message per chat, in ingestion order', () => {
  const collapsed = collapseToLatestPerChat([
    message({ id: 'A1', chat_jid: 'a@g.us', timestamp: '2026-09-13T10:00:00.000Z' }),
    message({ id: 'B1', chat_jid: 'b@g.us', timestamp: '2026-09-13T10:00:05.000Z' }),
    message({ id: 'A2', chat_jid: 'a@g.us', timestamp: '2026-09-13T10:00:09.000Z' }),
  ]);
  assert.deepEqual(collapsed.map((m) => m.id), ['B1', 'A2']);
});

test('conversation defaults keep the shared context and add the per-scope workspace', () => {
  const config = loadConfig({ HOME: os.tmpdir() }, '/repo/smolpaws');
  const defaults = conversationDefaultsForGroup(
    { tags: { ingress: 'whatsapp' }, agent_launch_additions: { system_message_suffix_append: 'paws' } },
    config,
    team,
  );
  assert.deepEqual(defaults.workspace, { kind: 'LocalWorkspace', working_dir: scopeWorkingDir('/repo/smolpaws', team) });
  assert.deepEqual(defaults.tags, { ingress: 'whatsapp', scope: 'team' });
  assert.deepEqual(defaults.agent_launch_additions, { system_message_suffix_append: 'paws' });
  assert.equal(scopeWorkingDir('/repo/smolpaws', team), path.join('/repo/smolpaws', 'groups', 'team'));
});

test('config resolves registered groups from the home dir, then the legacy checkout copy', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whatsapp-config-'));
  try {
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    const legacy = path.join(repo, 'data');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'registered_groups.json'), JSON.stringify({ 'x@g.us': team }));
    const fromLegacy = loadConfig({ HOME: home }, repo);
    assert.equal(fromLegacy.registeredGroupsPath, path.join(legacy, 'registered_groups.json'));
    assert.equal(Object.keys(fromLegacy.registeredGroups).length, 1);
    assert.equal(fromLegacy.authDir, path.join(home, '.smolpaws', 'whatsapp', 'auth'));

    const homeGroups = path.join(home, '.smolpaws', 'whatsapp', 'registered_groups.json');
    mkdirSync(path.dirname(homeGroups), { recursive: true });
    writeFileSync(homeGroups, JSON.stringify({ 'y@g.us': main, 'z@g.us': team }));
    const fromHome = loadConfig({ HOME: home }, repo);
    assert.equal(fromHome.registeredGroupsPath, homeGroups);
    assert.equal(Object.keys(fromHome.registeredGroups).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('direct commands split WhatsApp bursts before transcript rendering and preserve message order', () => {
  const input = [message({ id: 'a', content: 'hello' }), message({ id: 'b', content: '@smolpaws /condense' }), message({ id: 'c', content: 'after' })];
  const parts = splitCommandBatches(input, main, trigger);
  assert.deepEqual(parts.map(part => part.kind), ['messages', 'command', 'messages']);
  assert.equal(parts[1].kind === 'command' && parts[1].message.id, 'b');
  assert.equal(parts[0].kind === 'messages' && parts[0].messages[0].id, 'a');
  assert.equal(parts[2].kind === 'messages' && parts[2].messages[0].id, 'c');
});

test('WhatsApp command recognition preserves mention policy and excludes media, quoted and extended text', () => {
  const input = ['/condense', '> /condense', '/condense now', 'please /condense'].map(content => message({ content }));
  assert.deepEqual(splitCommandBatches(input, team, trigger).map(part => part.kind), ['messages']);
  assert.deepEqual(splitCommandBatches([message({ content: '/condense', media_path: '/tmp/public-fixture' })], main, trigger).map(part => part.kind), ['messages']);
  assert.deepEqual(splitCommandBatches([message({ content: '/condense' })], chatty, trigger).map(part => part.kind), ['command']);
});

test('missing direct-text provenance and adjacent quote mentions cannot authorize commands', () => {
  for (const content of ['>@smolpaws /condense', '> @smolpaws /condense']) {
    assert.deepEqual(splitCommandBatches([message({ content })], main, trigger).map(part => part.kind), ['messages']);
  }
  const captionWithoutDownloadedMedia = { ...message({ content: '@smolpaws /condense' }), command_eligible: 0 };
  assert.deepEqual(splitCommandBatches([captionWithoutDownloadedMedia], main, trigger).map(part => part.kind), ['messages']);
});
