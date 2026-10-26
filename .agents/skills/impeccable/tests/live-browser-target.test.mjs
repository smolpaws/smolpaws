import fs from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../scripts/live-browser.js', import.meta.url), 'utf8');
const extract = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const action = extract('  function actOnAgentTarget(msg) {', '\n  // SSE (server');
const go = extract('  function handleGo() {', '\n  function cancelInsertConfigure()');
const busy = extract('  function agentTargetBusyReason(exceptTargetId) {', '\n  // Targets this tab declined');
async function run(race) {
  let finishScroll, resolveRenewal;
  const log = [];
  const ctx = {
    state: 'CONFIGURING', configureKind: 'replace', currentSessionId: null,
    pendingApplyInFlight: false, AGENT_TARGET_CLIENT_ID:'test-client', selectedCount:3, selectedAction:'polish', agentTargetForGo:null, location:{pathname:'/'}, agentTargetsSeen: new Map([['target', 'acting']]),
    connected: true, selectedElement: null, PREFIX: 'test', goCalls: 0,
    annotEditing: false, annotState: {comments:[],strokes:[]}, editBadgeEl: null,
    variantObserver:null, window:{scrollY:0}, captureEvents:[],
    id8(){ return 'session'+(++ctx.goCalls); },
    buildPickedAnchorSnapshot(){return {};}, extractContext(){return {};},
    setLiveState(next){ctx.state=next;}, startVariantObserver(){return {disconnect(){}};},
    captureAndEmit(el,event){ctx.captureEvents.push(event);},
    agentTargetOverlayGone() { return !ctx.connected; },
    resolveAgentTargetElement() { return {el:{id:'target',getBoundingClientRect(){return {top:0};}}, matchCount:1}; },
    scrollAgentTargetIntoView(el, done) { finishScroll = done; },
    claimAgentTarget() { return new Promise(resolve => { resolveRenewal = resolve; }); },
    noteAgentTarget(id,status) { ctx.agentTargetsSeen.set(id,status); },
    postAgentTargetResult(id,result) { log.push(result); },
    declineAgentTargetBusy() { log.push('busy'); },
    beginNewLiveConfiguration() { ctx.state='CONFIGURING'; },
    uiGetById() { return {value:''}; },
    describeAgentTargetCandidate() { return {id:'target'}; },
  };
  for(const name of ['showHighlight','clearAnnotations','showAnnotOverlay','showBar','renderEditBadge','startScrollTracking','maybePrefetchPage','maybeWarnConditionalAncestor','updateBarContent','cancelInsertConfigure','stopVoice','disableInlineEdit','stripManualEditRuntimeState','clearMountErrorCard','resetSessionFileMeta','hideAnnotOverlay','saveSession','writeScrollY','startScrollLock']) ctx[name]=()=>{};
  vm.createContext(ctx);
  vm.runInContext(busy+'\n'+action+'\n'+go,ctx);
  ctx.actOnAgentTarget({targetId:'target',action:'bolder',count:3});
  if(race==='user-go-during-scroll') { ctx.selectedElement={getBoundingClientRect(){return {top:0};}}; ctx.handleGo(); }
  finishScroll();
  if(race==='teardown-during-renewal') ctx.connected=false;
  if(race==='user-go-during-renewal') { ctx.selectedElement={getBoundingClientRect(){return {top:0};}}; ctx.handleGo(); }
  resolveRenewal({granted:true});
  await new Promise(setImmediate);
  const expected = race.startsWith('user-go-') || race === 'idle' ? 1 : 0;
  assert.equal(ctx.goCalls, expected);
  assert.equal(ctx.captureEvents.length, expected);
  assert.equal(ctx.currentSessionId, expected ? 'session1' : null);
}

// Isolate real overlay functions; the DOM and lease boundary are controlled to reproduce await races.
for (const race of ['idle', 'user-go-during-scroll', 'user-go-during-renewal', 'teardown-during-renewal']) {
  it(`does not overwrite a live session: ${race}`, () => run(race));
}
