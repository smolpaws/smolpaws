import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WhatsAppLedger } from '../ledger.js';
import { assertLegacyHandoff, setWhatsAppOwnerMode, initializeWhatsAppProgress, markWhatsAppMessages, pendingWhatsAppClause } from '../../../../src/whatsapp-progress.js';
import { acquireWhatsAppOwner } from '../../../../src/whatsapp-owner.js';
import { loadConfig } from '../config.js';

test('real legacy JSON handoff, rollback and re-cutover preserve holes and unseen context', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-handoff-'));
  const dbPath = path.join(dir, 'messages.db');
  const statePath = path.join(dir, 'router_state.json');
  let ledger = new WhatsAppLedger(dbPath);
  const put = (id: string, timestamp: string) => ledger.storeMessage({ id, chatJid: 'chat', sender: 'human', senderName: 'Human', content: id, timestamp, isFromMe: false });
  try {
    put('old', '2026-09-14T09:00:00Z');
    put('pending', '2026-09-14T09:02:00Z');
    put('late-old', '2026-09-14T09:00:30Z'); // high sequence, old timestamp
    writeFileSync(statePath, JSON.stringify({ last_timestamp: '2026-09-14T09:01:00Z', last_agent_timestamp: { chat: '2026-09-14T09:00:00Z' } }));
    ledger.initializeProgress(statePath);
    assert.deepEqual(ledger.getNewMessages(['chat'], ledger.getDispatchSeq('chat'), 'cat').map(m => m.id), ['pending']);
    assert.deepEqual(ledger.getMessagesSince('chat', ledger.getLastAgentSeq('chat'), 'cat').map(m => m.id), ['pending', 'late-old']);
    ledger.setDispatchSeq('chat', 3);
    ledger.setLastAgentSeq('chat', 3);
    ledger.close();
    ledger = new WhatsAppLedger(dbPath);
    // Rollback reads the same identity progress, even with unchanged old JSON timestamps.
    initializeWhatsAppProgress(ledger.db, statePath);
    const legacyPending = () => ledger.db.prepare(`SELECT id, chat_jid FROM messages WHERE ${pendingWhatsAppClause('dispatched')}`).all() as { id: string; chat_jid: string }[];
    assert.deepEqual(legacyPending(), []);
    // An old binary's INSERT OR REPLACE must not re-deliver an already-handled identity.
    ledger.db.prepare('INSERT OR REPLACE INTO messages(id, chat_jid, content, timestamp) VALUES (?, ?, ?, ?)').run('old', 'chat', 'edited', '2026-09-14T09:00:00Z');
    put('offline', '2026-09-14T08:00:00Z');
    put('same-second', '2026-09-14T09:02:00Z');
    assert.deepEqual(legacyPending().map(m => m.id), ['offline', 'same-second']);
    const handled = legacyPending();
    markWhatsAppMessages(ledger.db, handled, 'dispatched');
    markWhatsAppMessages(ledger.db, handled, 'seen');
    ledger.initializeProgress(statePath); // re-cutover never reimports stale JSON
    assert.deepEqual(ledger.getNewMessages(['chat'], ledger.getDispatchSeq('chat'), 'cat'), []);
    put('new-tail', '2026-09-14T07:00:00Z');
    assert.deepEqual(ledger.getNewMessages(['chat'], ledger.getDispatchSeq('chat'), 'cat').map(m => m.id), ['new-tail']);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('historical ledger without known progress refuses startup; empty ledger initializes', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    ledger.storeMessage({ id: 'old', chatJid: 'chat', sender: 'x', senderName: 'x', content: 'hi', timestamp: '2026-01-01', isFromMe: false });
    assert.throws(() => ledger.initializeProgress(), /router_state/);
  } finally { ledger.close(); }
  const empty = new WhatsAppLedger(':memory:');
  try { empty.initializeProgress(); empty.initializeProgress(); } finally { empty.close(); }
});

test('one device owner and explicit canary state configuration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-owner-'));
  try {
    const config = loadConfig({ SMOLPAWS_HOME_DIR: dir, SMOLPAWS_WHATSAPP_REGISTERED_GROUPS: path.join(dir, 'only-main.json'), SMOLPAWS_WHATSAPP_STARTUP_PING: '0' }, dir);
    assert.equal(config.relayDbPath, path.join(dir, 'coordinator', 'whatsapp-relay-v1.db'));
    assert.equal(config.startupPing, false);
    const release = acquireWhatsAppOwner(config.authDir);
    assert.throws(() => acquireWhatsAppOwner(config.authDir), /already owned/);
    release();
    acquireWhatsAppOwner(config.authDir)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('legacy startup requires an explicit drain handoff after relay ownership', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    ledger.initializeProgress();
    setWhatsAppOwnerMode(ledger.db, 'relay');
    assert.throws(() => assertLegacyHandoff(ledger.db), /whatsapp:handoff/);
    setWhatsAppOwnerMode(ledger.db, 'legacy');
    assertLegacyHandoff(ledger.db);
  } finally { ledger.close(); }
});
