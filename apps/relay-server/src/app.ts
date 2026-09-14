/** SmolPaws composition over the upstream-shaped server: product tools, no extra HTTP routes. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../../../packages/openhands-agent-server/src/app.js';
import type { ProfileToolConfigurator } from '../../../packages/openhands-agent-server/src/profileAgentFactory.js';
import { TaskScheduler, type ScheduledLane } from '../../../src/coordinator/taskScheduler.js';
import { queueMedia } from '../../../src/coordinator/outboundMedia.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

export function productTools(scheduler: TaskScheduler): ProfileToolConfigurator {
  return (tools, { stored }) => {
    let lane = scheduler.lane(stored.id);
    if (!lane) {
      // A native server conversation is its own scope. HTTP tags cannot grant control authority.
      lane = { conversationId: stored.id, scopeId: `agent-server:${stored.id}`, workingDir: path.resolve(stored.workspace.working_dir),
        lane: { laneKey: `agent-server:${stored.id}`, platform: 'agent-server', accountId: null, chatId: stored.id, threadId: null },
        relayDbPath: process.env.SMOLPAWS_RELAY_DB_PATH || path.join(path.dirname(scheduler.db.name), 'agent-server-relay-v1.db'), defaults: stored.request as unknown as Record<string, unknown> } satisfies ScheduledLane;
      scheduler.register(lane);
    }
    const extensionTools = [...Object.values(sdk.TASK_SCHEDULER_TOOL_FACTORIES).map(make => make()), sdk.SendMessageTool.create(), sdk.SendMediaTool.create()];
    const all = new Map(tools.map(tool => [tool.name, tool]));
    for (const tool of extensionTools) {
      if (tool.name === 'send_message') { if (!all.has(tool.name)) all.set(tool.name, tool); continue; }
      const registered = lane;
      all.set(tool.name, new sdk.ToolDefinition({ name: tool.name, description: tool.description,
        inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations,
        meta: { ...tool.meta, smolpaws_execution_context: true },
        executor: (action, context) => {
          const actionId = (context as { actionEventId?: string } | undefined)?.actionEventId;
          if (!actionId) return { text: 'Missing durable action identity', is_error: true };
          if (tool.name !== 'send_media') return scheduler.execute(stored.id, tool.name, action as Record<string, unknown>, actionId);
          try { return { text: `Media queued: ${queueMedia(registered, action as Record<string, unknown>, actionId)}`, is_error: false }; }
          catch (error) { return { text: error instanceof Error ? error.message : String(error), is_error: true }; }
        },
      }));
    }
    return [...all.values()];
  };
}
export async function createRelayServerApp(options: AgentServerAppOptions = {}, scheduler = new TaskScheduler()): Promise<AgentServerApp & { scheduler: TaskScheduler }> {
  try {
    const server = await createAgentServerApp({ ...options, configureTools: productTools(scheduler) });
    server.app.addHook('onSend', async (_request, reply) => { reply.header('x-smolpaws-host', 'relay'); });
    server.app.addHook('onClose', async () => { scheduler.close(); });
    return { ...server, scheduler };
  } catch (error) { scheduler.close(); throw error; }
}
