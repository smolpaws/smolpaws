import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, InMemorySecretStore, llmProfileSchema, messageSchema } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentServerApp, type AgentServerApp } from '../app.js';
import { ConversationMetadataStore } from '../conversationMetadata.js';
import { PubSub } from '../pubSub.js';
const roots: string[] = [], servers: AgentServerApp[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(async () => { for (const server of servers.splice(0)) await server.app.close(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); vi.restoreAllMocks(); });
async function fixture(complete: (id:string) => Promise<void>, max=1) {
  const root = await mkdtemp(path.join(os.tmpdir(),'run-admission-')); roots.push(root);
  const calls:string[]=[];
  const server = await createAgentServerApp({
    config:{conversationsPath:path.join(root,'conversations'),statePath:path.join(root,'state'),workspaceRoot:root,maxConcurrentRuns:max},
    secretStore:new InMemorySecretStore(),
    agentFactory:(_settings,context)=>new Agent({llm:{profile:llmProfileSchema.parse({profileId:'fixture',providerId:'openai',model:'gpt-4o'}),complete:async()=>{
      calls.push(context.stored.id); await complete(context.stored.id); return {message:messageSchema.parse({role:'assistant',content:'done'}),usage:null};
    }}}),
  }); servers.push(server);
  const create=async(id=randomUUID())=>server.app.inject({method:'POST',url:'/api/conversations',payload:{id}});
  const send=(id:string,run=true)=>server.app.inject({method:'POST',url:`/api/conversations/${id}/events`,payload:{role:'user',content:'hello',run}});
  const idle=async(id:string)=>(await server.conversationService.getEventService(id))!.whenIdle();
  return {root,server,calls,create,send,idle};
}
test('full capacity rejects a new create before files, permits committed reattach and retains a rejected run message',async()=>{
  const entered=deferred(),release=deferred(); const f=await fixture(async()=>{entered.resolve();await release.promise;});
  const a=(await f.create()).json().id as string,b=(await f.create()).json().id as string;
  try {
    expect((await f.send(a)).statusCode).toBe(200);await entered.promise;
    const newId=randomUUID(); expect((await f.create(newId)).statusCode).toBe(429);
    expect(await readdir(path.join(f.root,'conversations'))).not.toContain(newId);
    expect((await f.create(a)).statusCode).toBe(200);
    const rejected=await f.send(b);expect(rejected.statusCode).toBe(429);expect(rejected.json().detail).toContain('Message saved');
    expect((await f.server.conversationService.getEventService(b))!.events().filter(e=>e.kind==='MessageEvent'&&e.source==='user')).toHaveLength(1);
    expect((await f.send(b,false)).statusCode).toBe(200);expect(f.calls).toEqual([a]);
    release.resolve();await f.idle(a);
    expect((await f.server.app.inject({method:'POST',url:`/api/conversations/${b}/run`})).statusCode).toBe(200);
    await f.idle(b);expect(f.calls).toEqual([a,b]);
  } finally {release.resolve();}
});
test('creation reservations precede asynchronous persistence and are released after failure',async()=>{
  const f=await fixture(async()=>{}),entered=deferred(),release=deferred();
  const original=ConversationMetadataStore.prototype.saveConversation;let fail=true;
  vi.spyOn(ConversationMetadataStore.prototype,'saveConversation').mockImplementation(async function(stored){
    if(fail){entered.resolve();await release.promise;fail=false;throw new Error('fixture save failed');}
    return original.call(this,stored);
  });
  const pending=f.create();await entered.promise;
  try {expect((await Promise.race([f.create(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Overload did not return promptly')),200))])).statusCode).toBe(429);} finally {release.resolve();}
  expect((await pending).statusCode).toBe(500);
  expect((await f.create()).statusCode).toBe(201);
});
test('terminal execution releases before metadata tail; accepted late input waits behind a competitor',async()=>{
  const competitorEntered=deferred(),competitorRelease=deferred(),tailEntered=deferred(),tailRelease=deferred();
  let competitor='';const f=await fixture(async id=>{if(id===competitor){competitorEntered.resolve();await competitorRelease.promise;}});
  const first=(await f.create()).json().id as string;competitor=(await f.create()).json().id as string;
  const original=PubSub.prototype.publish;let block=true;
  vi.spyOn(PubSub.prototype,'publish').mockImplementation(async function(event){
    if(block && typeof event==='object' && event!==null && 'kind' in event && event.kind==='ConversationStateUpdateEvent'){
      block=false;tailEntered.resolve();await tailRelease.promise;
    }
    return original.call(this,event);
  });
  try {
    expect((await f.send(first)).statusCode).toBe(200);await tailEntered.promise;
    expect((await f.send(competitor)).statusCode).toBe(200);await competitorEntered.promise;
    expect((await f.send(first)).statusCode).toBe(200);tailRelease.resolve();
    await new Promise(resolve=>setImmediate(resolve));expect(f.calls).toEqual([first,competitor]);
    competitorRelease.resolve();await f.idle(competitor);await f.idle(first);expect(f.calls).toEqual([first,competitor,first]);
  } finally {tailRelease.resolve();competitorRelease.resolve();}
});
