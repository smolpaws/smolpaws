import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, InMemorySecretStore, llmProfileSchema, messageSchema, type RootSpanOptions } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { mergeConversationObservability } from '../conversationObservability.js';
import { createAgentServerApp, type AgentServerApp } from '../app.js';
const headers={
 'x-openhands-observability-span-name':'automation.run',
 'x-openhands-observability-tags':' one, , two ',
 'x-openhands-observability-metadata':'{"automation":"a1","same":"header"}',
 'x-openhands-observability-parent-span-context':'parent',
};
test('merges headers before launch with body metadata keys and own-property overrides',()=>{
 expect(mergeConversationObservability({observability_metadata:{same:'body'}},headers)).toMatchObject({observability_span_name:'automation.run',observability_tags:['one','two'],observability_metadata:{automation:'a1',same:'body'},observability_parent_span_context:'parent'});
 expect(mergeConversationObservability({observability_span_name:null,observability_tags:[],observability_metadata:null,observability_parent_span_context:''},headers)).toMatchObject({observability_span_name:'conversation',observability_tags:[],observability_metadata:{automation:'a1',same:'header'},observability_parent_span_context:'parent'});
 expect(mergeConversationObservability({observability_tags:null,observability_span_name:'body',observability_parent_span_context:'body-parent'},headers)).toMatchObject({observability_span_name:'body',observability_tags:[],observability_parent_span_context:'body-parent'});
});
test.each(['{secret-invalid','[]','{"bad":{}}','{"bad":[true,1]}','{"":true}'])('rejects invalid header metadata without echoing it: %s',value=>{
 expect(()=>mergeConversationObservability({observability_metadata:{bad:'override'}},{'x-openhands-observability-metadata':value})).toThrow();
 try{mergeConversationObservability({}, {'x-openhands-observability-metadata':value});}catch(error){expect(String(error)).not.toContain(value);}
});
const roots:string[]=[],servers:AgentServerApp[]=[];
afterEach(async()=>{for(const server of servers.splice(0))await server.app.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.restoreAllMocks();});
test('persists context through restart and closes one actual local span without creating an unused agent',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'server-observability-'));roots.push(root);
 const end=vi.fn(),child=vi.fn(),spanFactory=vi.fn((_name:string,_options:RootSpanOptions)=>({end,beginChild:child}));
 const factory=vi.fn(()=>new Agent({llm:{profile:llmProfileSchema.parse({profileId:'fixture',providerId:'openai',model:'gpt-4o'}),complete:async()=>({message:messageSchema.parse({role:'assistant',content:'done'}),usage:null})}}));
 const options={config:{conversationsPath:path.join(root,'conversations'),statePath:path.join(root,'state'),workspaceRoot:root},secretStore:new InMemorySecretStore(),agentFactory:factory,observability:{env:{OTEL_ENDPOINT:'fixture'},spanFactory}};
 let server=await createAgentServerApp(options);servers.push(server);
 const response=await server.app.inject({method:'POST',url:'/api/conversations',headers,payload:{user_id:'user-1',observability_metadata:{same:'body'}}});expect(response.statusCode).toBe(201);const id=response.json().id as string;
 await server.app.close();expect(factory).not.toHaveBeenCalled();expect(end).not.toHaveBeenCalled();
 server=await createAgentServerApp(options);servers.push(server);
 expect((await server.app.inject({method:'POST',url:`/api/conversations/${id}/events`,payload:{role:'user',content:'hello'}})).statusCode).toBe(200);
 await (await server.conversationService.getEventService(id))!.whenIdle();
 expect(spanFactory).toHaveBeenCalledWith('conversation',expect.objectContaining({sessionId:id,userId:'user-1',parentSpanContext:'parent',metadata:{automation:'a1',same:'body'},tags:['one','two']}));expect(child).toHaveBeenCalledWith('automation.run',['one','two']);
 await server.app.close();await server.app.close();expect(end).toHaveBeenCalledTimes(1);
});
