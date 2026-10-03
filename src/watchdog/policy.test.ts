import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activity, recovery, recoverIfEligible, GRACE_MS, COOLDOWN_MS, type Health } from './policy.js';
test('requires strictly more than fifteen minutes observed down', () => {
  const first = recovery({}, 'down', 100, false);
  assert.equal(first.restart, false);
  assert.equal(recovery(first.state, 'down', 100 + GRACE_MS, false).restart, false);
  assert.equal(recovery(first.state, 'down', 101 + GRACE_MS, false).restart, true);
});
test('healthy, unknown, pause and clock rollback reset downtime', () => {
  for (const health of ['up','unknown'] as const) assert.equal(recovery({firstDown:1}, health, 1e7, false).state.firstDown, undefined);
  assert.equal(recovery({firstDown:1}, 'down', 1e7, true).restart, false);
  assert.equal(recovery({firstDown:100}, 'down', 10, false).restart, false);
  assert.equal(recovery({firstDown:1,lastRestart:100}, 'down', COOLDOWN_MS, false).restart, false);
});
test('heartbeat idle and conversation stopped are not an application outage', () => {
  assert.equal(activity('idle',0,false,false),'idle');
  assert.equal(activity('stopped',0,false,false),'idle');
  assert.equal(activity('running',0,true,false),'progress');
  assert.equal(activity('running',0,true,true),'stuck');
  assert.equal(activity('finished',1,false,false),'stuck');
});
test('fresh probe prevents racing a manual restart', async () => {
  let calls=0, starts=0;
  await recoverIfEligible({firstDown:1},1e7,{probe:async()=>++calls===1?'down':'up',paused:()=>false,save:()=>{},start:async()=>{starts++;}});
  assert.equal(starts,0);
});
test('maintenance arriving during probes suppresses recovery', async () => {
  let paused=false,starts=0,calls=0;
  await recoverIfEligible({firstDown:1},1e7,{probe:async()=>{if(++calls===2)paused=true;return 'down';},paused:()=>paused,save:()=>{},start:async()=>{starts++;}});
  assert.equal(starts,0);
});
test('start is persisted before invocation and recovery is verified', async () => {
  let health:Health='down',saved=false;
  const result=await recoverIfEligible({firstDown:1},1e7,{probe:async()=>health,paused:()=>false,
    save:s=>{if(s.lastRestart===1e7)saved=true;},start:async()=>{assert.ok(saved);health='up';}});
  assert.equal(result.health,'up'); assert.equal(result.state.firstDown,undefined);assert.equal(result.restarted,true);
});
