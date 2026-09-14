import { existsSync } from 'node:fs';
import path from 'node:path';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
/** Offline ownership handoff: no platform sends. Stop the bridge after its run/outbox drain first. */
import Database from 'better-sqlite3';
import { acquireWhatsAppOwner } from '../../../src/whatsapp-owner.js';
import { setWhatsAppOwnerMode } from '../../../src/whatsapp-progress.js';
import { loadConfig } from './config.js';
import { WhatsAppLedger } from './ledger.js';

export async function verifyRelayDrained(db: Database.Database, serverUrl: string, apiKey?: string): Promise<void> {
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM work WHERE state NOT IN ('done', 'skipped')").get() as { n: number }).n;
  if (pending) throw new Error(`${pending} unsettled relay rows; keep the bridge running to drain or reconcile them first`);
  const lanes = db.prepare('SELECT conversation_id FROM lanes WHERE conversation_ready = 1').all() as { conversation_id: string }[];
  for (const lane of lanes) {
    const base = `${serverUrl.replace(/\/+$/, '')}/api/conversations/${encodeURIComponent(lane.conversation_id)}`;
    const request = async (url: string) => {
      const response = await fetch(url, { headers: apiKey ? { 'x-session-api-key': apiKey } : {}, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Cannot verify stopped relay conversation: HTTP ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const info = await request(base);
    if (!['finished', 'idle'].includes(String(info.execution_status).toLowerCase())) throw new Error('Relay conversation is not finished/idle; finish or reconcile it before rollback');
    const row = db.prepare('SELECT next_page_id AS cursor FROM projection_cursors WHERE conversation_id = ?').get(lane.conversation_id) as { cursor: string } | undefined;
    const page = await request(`${base}/events/search?page_id=${encodeURIComponent(row?.cursor ?? '0')}&limit=1`);
    if (!Array.isArray(page.items) || page.items.length) throw new Error('Relay EventLog has unprojected work; drain the outbox before rollback');
  }
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'legacy') throw new Error('Usage: npm run whatsapp:handoff -- legacy');
  const config = loadConfig();
  const release = acquireWhatsAppOwner(config.authDir);
  const ledger = new WhatsAppLedger(config.ledgerPath);
  let relay: Database.Database | undefined;
  try {
    ledger.initializeProgress(config.routerStatePath);
    try { if (existsSync(config.relayDbPath!)) relay = new Database(config.relayDbPath!, { readonly: true, fileMustExist: true }); }
    catch (error) { if ((error as { code?: string }).code !== 'SQLITE_CANTOPEN') throw error; }
    if (relay) await verifyRelayDrained(relay, process.env.SMOLPAWS_RELAY_SERVER_URL || 'http://127.0.0.1:8790', process.env.SMOLPAWS_RELAY_SERVER_API_KEY);
    const scheduler = new TaskScheduler(process.env.SMOLPAWS_SCHEDULER_DB_PATH || path.join(path.dirname(config.relayDbPath!), 'scheduler.db'));
    try { scheduler.exportLegacy(ledger.db, config.ledgerPath); } finally { scheduler.close(); }
    setWhatsAppOwnerMode(ledger.db, 'legacy');
    console.log('Progress is ready for the updated legacy host. No messages were sent.');
  } finally { relay?.close(); ledger.close(); release(); }
}

if (process.argv[1]?.endsWith('/handoff.ts')) void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
