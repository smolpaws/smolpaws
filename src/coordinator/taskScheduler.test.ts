import Database from 'better-sqlite3';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskScheduler, type ScheduledLane } from './taskScheduler.js';
import { deterministicEventId } from './ids.js';

const lane = (platform: string, scopeId: string): ScheduledLane => ({ conversationId: `${platform}-${scopeId}`, scopeId, workingDir: '/tmp', relayDbPath: '/tmp/relay.db', defaults: {}, lane: { laneKey: `${platform}:${scopeId}`, platform, chatId: scopeId, accountId: null, threadId: null } });
const taskAction = { prompt: 'check', schedule_type: 'interval', schedule_value: '1000', context_mode: 'isolated' };
test('shared scheduler preserves tool results, scope checks, edits and due occurrence across restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scheduler-')); let now = Date.parse('2026-09-14T10:00:00Z');
  let scheduler = new TaskScheduler(path.join(dir, 'scheduler.db'), () => now);
  try {
    for (const l of [lane('whatsapp', 'main'), lane('slack', 'team'), lane('discord', 'other')]) scheduler.register(l);
    const created = scheduler.execute('whatsapp-main', 'schedule_task', { ...taskAction, target_group: 'team' }, 'a');
    assert.equal(created.is_error, false); const id = JSON.parse(created.text).task_id;
    assert.deepEqual(scheduler.execute('whatsapp-main', 'schedule_task', taskAction, 'a'), created);
    assert.equal(scheduler.execute('discord-other', 'pause_task', { task_id: id }, 'b').is_error, true);
    assert.equal(scheduler.execute('slack-team', 'schedule_task', { ...taskAction, target_group: 'main' }, 'c').is_error, true);
    assert.equal(JSON.parse(scheduler.execute('discord-other', 'list_tasks', {}, 'd').text).length, 0);
    scheduler.execute('slack-team', 'update_task', { task_id: id, prompt: 'updated' }, 'e');
    now += 1000;
    assert.equal(scheduler.due('discord').length, 0);
    const [run] = scheduler.due('slack'); assert.equal(run.prompt, 'updated');
    assert.notEqual(run.conversation_id, 'slack-team');
    scheduler.close(); scheduler = new TaskScheduler(path.join(dir, 'scheduler.db'), () => now);
    assert.deepEqual(scheduler.due('slack'), [run]);
    scheduler.enqueued(run.id); assert.deepEqual(scheduler.due('slack'), []);
    scheduler.observe(run.conversation_id, { id: deterministicEventId('slack', run.source_id), kind: 'MessageEvent' });
    scheduler.observe(run.conversation_id, { id: 'finish', kind: 'ObservationEvent', tool_name: 'finish', observation: { message: 'done' } });
    const tasks = JSON.parse(scheduler.execute('slack-team', 'list_tasks', {}, 'f').text);
    assert.equal(tasks[0].last_result, 'done'); assert.equal(tasks[0].next_run, new Date(now + 1000).toISOString());
    scheduler.execute('slack-team', 'pause_task', { task_id: id }, 'g'); now += 2000;
    assert.deepEqual(scheduler.due('slack'), []);
    scheduler.execute('slack-team', 'resume_task', { task_id: id }, 'h'); now += 1000;
    assert.equal(scheduler.due('slack').length, 1);
    scheduler.execute('whatsapp-main', 'cancel_task', { task_id: id }, 'i');
    assert.deepEqual(scheduler.due('slack'), []);
  } finally { scheduler.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('once, cron, validation and serial group runs use the same scheduler on agent-server', () => {
  let now = Date.parse('2026-09-14T10:00:00Z'); const scheduler = new TaskScheduler(':memory:', () => now, 'UTC');
  try {
    scheduler.register(lane('agent-server', 'own'));
    const execute = (action: Record<string, unknown>, id: string) => scheduler.execute('agent-server-own', 'schedule_task', action, id);
    assert.equal(execute({ ...taskAction, schedule_value: 'no' }, 'bad').is_error, true);
    const cron = execute({ ...taskAction, schedule_type: 'cron', schedule_value: '*/5 * * * *' }, 'cron');
    assert.equal(JSON.parse(cron.text).next_run, '2026-09-14T10:05:00.000Z');
    for (const id of ['a', 'b']) execute({ ...taskAction, context_mode: 'group', schedule_type: 'once', schedule_value: new Date(now).toISOString() }, id);
    const [run] = scheduler.due('agent-server'); assert.equal(scheduler.due('agent-server').length, 1);
    assert.equal(run.conversation_id, 'agent-server-own'); scheduler.enqueued(run.id);
    scheduler.observe(run.conversation_id, { id: deterministicEventId('agent-server', run.source_id), kind: 'MessageEvent' });
    scheduler.observe(run.conversation_id, { id: 'done', kind: 'MessageEvent', llm_message: { role: 'assistant', content: [{ text: 'done' }] } });
    assert.equal(scheduler.due('agent-server').length, 1);
  } finally { scheduler.close(); }
});

test('scheduler handoff exports edits and cancellation, refuses active runs, and re-imports legacy changes', () => {
  const scheduler = new TaskScheduler(':memory:', () => 1000); const ledger = new Database(':memory:'); const registration = lane('whatsapp', 'main'); scheduler.register(registration);
  try {
    const result = scheduler.execute(registration.conversationId, 'schedule_task', taskAction, 'create'); const id = JSON.parse(result.text).task_id;
    scheduler.exportLegacy(ledger, 'ledger');
    assert.equal((ledger.prepare('SELECT id FROM scheduled_tasks').get() as { id: string }).id, id);
    ledger.prepare('UPDATE scheduled_tasks SET prompt=?, status=? WHERE id=?').run('legacy edited', 'paused', id);
    scheduler.importLegacy(ledger, 'ledger', [registration]);
    const tasks = JSON.parse(scheduler.execute(registration.conversationId, 'list_tasks', {}, 'list').text);
    assert.equal(tasks[0].prompt, 'legacy edited'); assert.equal(tasks[0].status, 'paused');
    scheduler.exportLegacy(ledger, 'ledger'); ledger.prepare('DELETE FROM scheduled_tasks').run();
    scheduler.importLegacy(ledger, 'ledger', [registration]);
    assert.equal(JSON.parse(scheduler.execute(registration.conversationId, 'list_tasks', {}, 'list2').text).length, 0);
    scheduler.execute(registration.conversationId, 'schedule_task', { ...taskAction, schedule_type: 'once', schedule_value: new Date(1000).toISOString() }, 'due');
    scheduler.due('whatsapp'); assert.throws(() => scheduler.exportLegacy(ledger, 'ledger'), /reconcile/);
  } finally { scheduler.close(); ledger.close(); }
});
