/** Hourly, local-only observer. No transcript text is sent to Jev. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { JevClient, choice, type JevState } from '../src/shared/jev.js';
import { acquireProcessOwner } from '../src/whatsapp-owner.js';
import { activity, recoverIfEligible, type Health, type ServiceState, type Status } from '../src/watchdog/policy.js';
import { buildHeartbeatConversationId } from '../apps/agent-server/src/agent-server/heartbeat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.SMOLPAWS_HOME_DIR || path.join(homedir(), '.smolpaws');
const dir = path.join(home, 'watchdog');
const stateFile = path.join(dir, 'state.json');
const controlFile = path.join(dir, 'control.json');
const url = (process.env.SMOLPAWS_RELAY_SERVER_URL || process.env.SMOLPAWS_COORD_SERVER_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const labels = ['com.smolpaws.relay-server', 'com.smolpaws.bridge.whatsapp'];
type Scope = { status: Status | null; checkedAt: number; error?: string; fingerprint?: string; conversation?: string; basis?: string };
type State = { epoch: string; boot: number; services: Record<string,ServiceState>; scopes: Record<string,Scope> };
function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file,'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new Error('invalid_state_file'); }
}
function write(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value,null,2)+'\n', {mode:0o600}); renameSync(temporary,file);
}
function control() { return read<{paused:boolean;epoch:string;services?:string[]}>(controlFile,{paused:false,epoch:'initial',services:[]}); }
function loaded(label: string) {try {launch(['print',`${domain}/${label}`]);return true;}catch{return false;}}
function launch(args: string[]) { return execFileSync('/bin/launchctl',args,{encoding:'utf8',timeout:5000,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']}); }
const domain = `gui/${process.getuid!()}`;
function processHealth(label: string): Health {
  try {
    const disabled = launch(['print-disabled',domain]);
    if (disabled.includes(`"${label}" => true`)) return 'unknown'; // explicit operator stop
    const output = launch(['print',`${domain}/${label}`]);
    const pid = output.match(/^\s*pid = (\d+)$/m);
    if (pid) { try { process.kill(Number(pid[1]),0);return 'up'; } catch {return 'unknown';} }
    return /^\s*state = (not running|waiting|exited)$/m.test(output) ? 'down' : 'unknown';
  } catch (e) {
    return String((e as {stderr?:unknown}).stderr).includes('Could not find service') ? 'down' : 'unknown';
  } // A missing job can be stopped, but recovery still requires a loaded job.
}
async function endpointHealth(): Promise<Health> {
  try {
    const r=await fetch(`${url}/health`,{signal:AbortSignal.timeout(3000)});
    return r.ok && r.headers.get('x-smolpaws-host')==='relay' ? 'up' : 'unknown';
  } catch(e) {
    return (e as {cause?:{code?:string}}).cause?.code==='ECONNREFUSED' ? 'down' : 'unknown';
  }
}
async function serverHealth(): Promise<boolean> {return await endpointHealth()==='up';}
async function probe(label: string): Promise<Health> {
  const p=processHealth(label);
  if(label!==labels[0])return p;
  const endpoint=await endpointHealth();
  // A listener outside the expected LaunchAgent must never gain a competitor.
  if(endpoint==='up')return 'up';
  if(endpoint==='unknown')return 'unknown';
  return p;
}
function digest(value: unknown) {return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);}
async function api(route: string) {
  const key=process.env.SMOLPAWS_RELAY_SERVER_API_KEY || process.env.SMOLPAWS_COORD_SERVER_API_KEY || process.env.OPENHANDS_SESSION_API_KEY || process.env.SESSION_API_KEY;
  const r=await fetch(`${url}${route}`,{headers:key?{'x-session-api-key':key}:{},signal:AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error(`server_http_${r.status}`);
  return r.json();
}
async function judge(metadata: unknown): Promise<'progress'|'stuck'|null> {
  const client=new JevClient({model:'jev-1.13.0',timeoutMs:10_000});
  const body=await client.ask(metadata as JevState,{activity:choice(
    'Assess operational activity from event metadata only. Repeated tool-result signatures suggest looping; new distinct events suggest progress. No text is available: do not claim semantic task completion. Choose uncertain if evidence is insufficient.',
    {progress:'Active work with fresh distinct events',stuck:'Repeated actions/results without advancement',uncertain:'Insufficient evidence'},
  )});
  const a=body.answers.activity;
  if (a?.type!=='choice' || !Number.isFinite(a.confidence) || a.confidence<0 || a.confidence>1 || !['progress','stuck','uncertain'].includes(a.choice)) throw new Error('jev_invalid_answer');
  return a.confidence>=0.8 && (a.choice==='progress'||a.choice==='stuck')?a.choice:null;
}
async function observe(id: string, pending: number, previous: Scope | undefined, now: number, useJev: boolean): Promise<Scope> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_conversation_id');
  const info=await api(`/api/conversations/${id}`) as any;
  const page=await api(`/api/conversations/${id}/events/search?limit=24&sort_order=TIMESTAMP_DESC`) as any;
  if (!Array.isArray(page.items)) throw new Error('invalid_events');
  const events=page.items as Record<string,any>[];
  const fingerprint=digest(events.map(e=>e.id));
  const latest=Math.max(0,...events.map(e=>Date.parse(e.timestamp)||0));
  const changed=previous?.conversation===id ? previous.fingerprint!==fingerprint : now-latest<60*60_000;
  const signatures=events.filter(e=>e.kind==='ActionEvent'||e.kind==='ObservationEvent').map(e=>digest({kind:e.kind,action:e.action,observation:e.observation}));
  const repeated=signatures.length>=8 && new Set(signatures).size<=2;
  const status=activity(String(info.execution_status).toLowerCase(),pending,changed,repeated);
  const result:Scope={status,checkedAt:now,conversation:id,fingerprint,basis:'runtime_and_event_activity'};
  if(useJev && status!=='idle' && changed) {
    try {
      // Only shape/count/age and locally assigned repetition numbers leave this Mac.
      const unique=[...new Set(signatures)];
      const answer=await judge({execution:info.execution_status,pending,eventCount:events.length,
        latestAgeSeconds:Math.round((now-latest)/1000),changed,repetitionPattern:signatures.map(s=>unique.indexOf(s))});
      if(answer) {result.status=answer;result.basis='jev_metadata';}
      else result.error='jev_uncertain_using_runtime_evidence';
    } catch {result.error='jev_unavailable_using_runtime_evidence';}
  }
  return result;
}
async function run(dry: boolean, noJev: boolean) {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('watchdog_requires_local_server');
  const release=acquireProcessOwner(dir,'Watchdog');
  try {
    const now=Date.now(),boot=now-uptime()*1000,c=control();
    let state=read<State>(stateFile,{epoch:c.epoch,boot,services:{},scopes:{}});
    if (!state.services || !state.scopes || !Number.isFinite(state.boot)) throw new Error('invalid_watchdog_state');
    if(state.epoch!==c.epoch || Math.abs(state.boot-boot)>60_000) state={epoch:c.epoch,boot,services:{},scopes:{}};
    const save=()=>{if(!dry)write(stateFile,state);};
    const health:Record<string,Health>={}; const recoveryResults:Record<string,string>={};
    for(const label of labels) {
      try {
        const result=await recoverIfEligible(state.services[label]||{},now,{
          probe:()=>probe(label),paused:()=>dry||control().paused||!!control().services?.includes(label)||control().epoch!==c.epoch||!loaded(label),
          save:s=>{state.services[label]=s;save();},
          start:async()=>{
            launch(['kickstart',`${domain}/${label}`]); // no -k: never kill a manually recovered process
            for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,1000));if(await probe(label)==='up')return;}
          }});
        health[label]=result.health;
        if(result.restarted)recoveryResults[label]=result.health==='up'?'recovered':'recovery_not_verified';
      } catch {health[label]='unknown';recoveryResults[label]='recovery_check_failed';}
    }
    const ready=await serverHealth();
    const dbPath=process.env.SMOLPAWS_RELAY_DB_PATH || path.join(home,'coordinator','whatsapp-relay-v1.db');
    const groupsPath=process.env.SMOLPAWS_WHATSAPP_REGISTERED_GROUPS || path.join(home,'whatsapp','registered_groups.json');
    const groups=read<Record<string,{folder:string}>>(groupsPath,{});
    const db=new Database(dbPath,{readonly:true,fileMustExist:true});
    try {
      for(const folder of ['main','hunting','openhands']) {
        try {
          if(labels.some(l=>health[l]==='down')){state.scopes[folder]={status:'stopped',checkedAt:now};continue;}
          if(!ready)throw new Error('service_probe_uncertain');
          const chat=Object.entries(groups).find(([,g])=>g.folder===folder)?.[0];
          if(!chat)throw new Error('scope_not_registered');
          const lanes=db.prepare("SELECT lane_key,conversation_id FROM lanes WHERE platform='whatsapp' AND chat_id=? AND thread_id IS NULL").all(chat) as {lane_key:string;conversation_id:string}[];
          const current=lanes.filter(l=>/^whatsapp:[^:]+:[^:]+$/.test(l.lane_key));
          if(current.length!==1)throw new Error('ambiguous_current_lane');
          const lane=current[0];
          const pending=(db.prepare("SELECT count(*) AS n FROM work WHERE lane_key=? AND state NOT IN ('done','skipped')").get(lane.lane_key) as {n:number}).n;
          state.scopes[folder]=await observe(lane.conversation_id,pending,state.scopes[folder],now,!noJev);
          if(health[labels[1]]==='unknown')state.scopes[folder].error='whatsapp_service_unloaded_or_probe_uncertain';
        }catch(e){state.scopes[folder]={...state.scopes[folder],status:state.scopes[folder]?.status??null,checkedAt:now,error:(e as Error).message};}
      }
    } finally {db.close();}
    try {
      if(health[labels[0]]==='down')state.scopes.heartbeat={status:'stopped',checkedAt:now};
      else {
        if(!ready)throw new Error('service_probe_uncertain');
        const heartbeat=launch(['print',`${domain}/com.smolpaws.heartbeat`]);
        const id=buildHeartbeatConversationId(new Date());
        try {state.scopes.heartbeat=await observe(id,0,state.scopes.heartbeat,now,!noJev);}
        catch(e) {
          if((e as Error).message!=='server_http_404')throw e;
          // A daily scheduled launcher normally has no process between successful runs.
          const failed=/last exit code = ([1-9]\d*)/.test(heartbeat);
          state.scopes.heartbeat={status:failed?'stuck':'idle',checkedAt:now,basis:'scheduled_launcher',
            ...(/\bpid = \d+/.test(heartbeat)?{error:'heartbeat_starting_no_conversation_yet'}:{})};
        }
      }
    }catch{state.scopes.heartbeat={...state.scopes.heartbeat,status:state.scopes.heartbeat?.status??null,checkedAt:now,error:'heartbeat_probe_failed'};}
    save();
    const report={checkedAt:new Date(now).toISOString(),maintenance:{all:control().paused,services:control().services||[]},health,recovery:recoveryResults,scopes:state.scopes};
    if(!dry){write(path.join(dir,'status.json'),report);write(path.join(dir,'error.json'),{checkedAt:new Date(now).toISOString(),error:null});} // bounded replacement, no transcript/log accumulation
    console.log(JSON.stringify(report,null,2));
  }finally{release();}
}
mkdirSync(dir,{recursive:true,mode:0o700});
const command=process.argv[2]||'check';
if(command==='pause'||command==='resume') {
  const target=process.argv[3];
  if(target && !['whatsapp','server'].includes(target))throw new Error('Maintenance target must be whatsapp or server');
  const current=control();const service=target==='whatsapp'?labels[1]:labels[0];
  const services=new Set(current.services||[]);
  if(target) {if(command==='pause')services.add(service);else services.delete(service);}
  write(controlFile,{paused:target?current.paused:command==='pause',services:[...services],epoch:randomUUID()});
  console.log(`${target||'All'} recovery ${command==='pause'?'paused':'resumed'}; observation continues.`);
}else if(command==='status') console.log(JSON.stringify(read(path.join(dir,'status.json'),{error:'not_checked_yet'}),null,2));
else if(command==='check') {
  try {await run(process.argv.includes('--dry-run'),process.argv.includes('--no-jev'));}
  catch {
    if(!process.argv.includes('--dry-run'))write(path.join(dir,'error.json'),{checkedAt:new Date().toISOString(),error:'watchdog_check_failed'});
    process.exitCode=1;console.error('Watchdog check failed; previous status may be stale.');
  }
}
else throw new Error('Usage: watchdog.ts check [--dry-run] [--no-jev] | status | pause | resume');
