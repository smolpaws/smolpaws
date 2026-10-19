import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationService } from '../conversationService.js';
import { ConversationLease } from '../conversationLease.js';
import { ConversationMetadataStore } from '../conversationMetadata.js';
import { startConversationRequestSchema, forkConversationRequestSchema } from '../models.js';
const roots:string[]=[],services:ConversationService[]=[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
afterEach(async()=>{for(const service of services.splice(0))await service.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.restoreAllMocks();});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'conversation-lifecycle-'));roots.push(root);const service=new ConversationService({persistenceDir:root,secretStore:new InMemorySecretStore(),maxConcurrentRuns:2});services.push(service);return service;}
function gateSave(id:string){const entered=deferred(),release=deferred();const original=ConversationMetadataStore.prototype.saveConversation;let calls=0;vi.spyOn(ConversationMetadataStore.prototype,'saveConversation').mockImplementation(async function(stored){if(stored.id===id&&++calls===1){entered.resolve();await release.promise;}return original.call(this,stored);});return {entered,release};}
function gateClaim(id:string){const entered=deferred(),release=deferred();const original=ConversationLease.prototype.claim;let calls=0;vi.spyOn(ConversationLease.prototype,'claim').mockImplementation(async function(){const result=await original.call(this);if(path.basename(this.conversationDir)===id&&++calls===1){entered.resolve();await release.promise;}return result;});return {entered,release};}
test('concurrent same-ID creation commits once and never replays initial input',async()=>{
 const service=await fixture(),id=randomUUID(),gate=gateClaim(id);
 const request=startConversationRequestSchema.parse({id,initial_message:{role:'user',content:'once',run:false}});
 const first=service.startConversation(request);await gate.entered.promise;
 const second=service.startConversation(request);await new Promise(resolve=>setImmediate(resolve));gate.release.resolve();
 const results=await Promise.all([first,second]);expect(results.map(r=>r.isNew).sort()).toEqual([false,true]);
 expect((await service.getEventService(id))!.events().filter(e=>e.kind==='MessageEvent')).toHaveLength(1);
});
test('concurrent forks to one destination have one winner and preserve its copied history',async()=>{
 const service=await fixture();const source=await service.startConversation(startConversationRequestSchema.parse({initial_message:{role:'user',content:'source',run:false}}));
 const id=randomUUID(),gate=gateClaim(id);const request=forkConversationRequestSchema.parse({id,reset_metrics:true});
 const first=service.forkConversation(source.info.id,request);await gate.entered.promise;
 const second=service.forkConversation(source.info.id,request);const rejected=expect(second).rejects.toThrow('already exists');await new Promise(resolve=>setImmediate(resolve));gate.release.resolve();
 expect((await first)?.id).toBe(id);await rejected;
 expect((await service.getEventService(id))!.events().filter(e=>e.kind==='MessageEvent')).toHaveLength(1);
});
test('failed initialization can retry the same destination and shutdown drains enrolled work',async()=>{
 const service=await fixture(),id=randomUUID();vi.spyOn(ConversationMetadataStore.prototype,'saveConversation').mockRejectedValueOnce(new Error('save failed'));
 await expect(service.startConversation(startConversationRequestSchema.parse({id}))).rejects.toThrow('save failed');vi.restoreAllMocks();
 const gate=gateSave(id),pending=service.startConversation(startConversationRequestSchema.parse({id}));await gate.entered.promise;
 let closed=false;const closing=service.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));expect(closed).toBe(false);
 gate.release.resolve();expect((await pending).isNew).toBe(true);await closing;expect(closed).toBe(true);
 await expect(service.startConversation(startConversationRequestSchema.parse({id:randomUUID()}))).rejects.toThrow('closing');
});
