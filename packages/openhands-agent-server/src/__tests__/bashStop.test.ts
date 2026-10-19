import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { BashEventService } from '../bashService.js';
import { PubSub } from '../pubSub.js';
import { executeBashRequestSchema } from '../models.js';
const roots:string[]=[],services:BashEventService[]=[];const pids:string[]=[];
afterEach(async()=>{for(const file of pids.splice(0)){const pid=Number(await readFile(file,'utf8').catch(()=>''));if(pid>0)try{process.kill(-pid,'SIGKILL');}catch{ /* already exited */ }}for(const service of services.splice(0))await service.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.restoreAllMocks();});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'bash-stop-'));roots.push(root);const service=new BashEventService({bashEventsDir:path.join(root,'events')});services.push(service);return {root,service};}
async function ready(file:string){for(let i=0;i<200;i++){try{await access(file);return;}catch{await new Promise(r=>setTimeout(r,10));}}throw new Error('Shell did not become ready');}
async function command(service:BashEventService,root:string,suffix:string,body:string){const pid=path.join(root,`${suffix}.pid`),marker=path.join(root,`${suffix}.ready`);pids.push(pid);const running=await service.startBashCommand(executeBashRequestSchema.parse({command:`echo $$ > '${pid}'; ${body.replaceAll('READY',`touch '${marker}'`)}`,cwd:root,timeout:20}));await ready(marker);return running;}
test('stops one group, preserves trap output and actual exit code, and leaves another group running',async()=>{
 const {root,service}=await fixture();const first=await command(service,root,'first',"trap 'echo stopped; exit 0' TERM; READY; while :; do sleep 0.05; done");
 const second=await command(service,root,'second',"READY; while :; do sleep 0.05; done");
 expect(await service.stopBashCommand(first.command.id)).toBe(true);await first.task;
 const output=(await service.searchBashEvents({commandId:first.command.id,kind:'BashOutput'})).items;
 expect(output.filter(e=>e.kind==='BashOutput'&&e.exit_code!==null)).toHaveLength(1);
 expect(output.at(-1)).toMatchObject({exit_code:0,stdout:'stopped\n'});
 expect((await service.searchBashEvents({commandId:second.command.id,kind:'BashOutput'})).items).toHaveLength(0);
 expect(await service.stopBashCommand(first.command.id)).toBe(true);
 expect(await service.stopBashCommand('11111111-1111-4111-8111-111111111111')).toBe(false);
 await service.stopBashCommand(second.command.id);await second.task;
});
test('pending stop survives command publication before spawn',async()=>{
 const {service,root}=await fixture();const original=PubSub.prototype.publish;
 vi.spyOn(PubSub.prototype,'publish').mockImplementation(async function(event){
  if(typeof event==='object'&&event!==null&&'kind' in event&&event.kind==='BashCommand'&&'id' in event)expect(await service.stopBashCommand(String(event.id))).toBe(true);
  return original.call(this,event);
 });
 const running=await service.startBashCommand(executeBashRequestSchema.parse({command:'sleep 20',cwd:root,timeout:20}));
 await running.task;
 expect((await service.searchBashEvents({commandId:running.command.id,kind:'BashOutput'})).items).toHaveLength(1);
});
test('repeated stops escalate a TERM-ignoring group and drain inherited descendant pipes',async()=>{
 const {root,service}=await fixture();const running=await command(service,root,'ignore',"trap '' TERM; sleep 20 & READY; wait");
 await Promise.all([service.stopBashCommand(running.command.id),service.stopBashCommand(running.command.id)]);await running.task;
 const output=(await service.searchBashEvents({commandId:running.command.id,kind:'BashOutput'})).items;
 expect(output).toHaveLength(1);expect(output[0]).toMatchObject({exit_code:-9});
},10000);
test('timeout waits for TERM trap output and close drains owned commands',async()=>{
 const {root,service}=await fixture();
 const timed=await service.startBashCommand(executeBashRequestSchema.parse({command:"trap 'echo timeout-cleanup; exit 0' TERM; while :; do sleep 0.05; done",cwd:root,timeout:1}));
 await timed.task;expect((await service.searchBashEvents({commandId:timed.command.id,kind:'BashOutput'})).items.at(-1)).toMatchObject({exit_code:-1,stdout:'timeout-cleanup\n'});
 const running=await command(service,root,'close',"READY; sleep 20 & wait");await service.close();await running.task;
 await expect(service.startBashCommand(executeBashRequestSchema.parse({command:'true'}))).rejects.toThrow('closing');
},10000);
