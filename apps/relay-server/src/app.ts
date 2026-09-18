/** SmolPaws composition over the upstream-shaped server: product tools, no extra HTTP routes. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../../../packages/openhands-agent-server/src/app.js';
import { resolveProfileTool, type ProfileToolConfigurator } from '../../../packages/openhands-agent-server/src/profileAgentFactory.js';
import type { StoredConversation } from '../../../packages/openhands-agent-server/src/models.js';
import { TaskScheduler, type ScheduledLane } from '../../../src/coordinator/taskScheduler.js';
import { queueMedia } from '../../../src/coordinator/outboundMedia.js';
import { nativeRelayDbPath } from './relayPaths.js';
import { productContext, type ProductContextOptions } from './context.js';
import { productCondenserProfileSelection, productProfileSelection, type ProductModelOptions } from './models.js';
import { loadScheduledAgent, type ScheduledAgentOptions } from './scheduledAgents.js';
import { scheduledAgentTools, type SlackCheckerFactory } from './scheduledAgentTools.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

function productLane(scheduler: TaskScheduler, stored: StoredConversation): ScheduledLane {
  let lane = scheduler.lane(stored.id);
  if (!lane) {
    // A native server conversation is its own scope. HTTP tags cannot grant control authority.
    lane = { conversationId: stored.id, scopeId: `agent-server:${stored.id}`, workingDir: path.resolve(stored.workspace.working_dir),
      lane: { laneKey: `agent-server:${stored.id}`, platform: 'agent-server', accountId: null, chatId: stored.id, threadId: null },
      relayDbPath: nativeRelayDbPath(scheduler.db.name), defaults: stored.request as unknown as Record<string, unknown> } satisfies ScheduledLane;
    scheduler.register(lane);
  }
  return lane;
}

export function productTools(scheduler: TaskScheduler, options: { scheduledAgents?: ScheduledAgentOptions; slackCheckerFactory?: SlackCheckerFactory } = {}): ProfileToolConfigurator {
  return (tools, { stored }) => {
    const lane = productLane(scheduler, stored);
    const scheduled = loadScheduledAgent(stored.id, scheduler, options.scheduledAgents);
    const extensionTools = [...Object.values(sdk.TASK_SCHEDULER_TOOL_FACTORIES).map(make => make()), sdk.SendMessageTool.create(), sdk.SendMediaTool.create()];
    const all = new Map(tools.map(tool => [tool.name, tool]));
    for (const tool of extensionTools) {
      // Widen schemas at the heterogeneous registry boundary; execute still validates each action.
      const inputSchema: Sdk.ToolDefinition['inputSchema'] = tool.inputSchema;
      const outputSchema: Sdk.ToolDefinition['outputSchema'] = tool.outputSchema;
      if (tool.name === 'send_message') {
        if (!all.has(tool.name)) all.set(tool.name, new sdk.ToolDefinition({
          name: tool.name, description: tool.description, inputSchema, outputSchema,
          annotations: tool.annotations, meta: tool.meta, executor: (action, context) => tool.execute(action, context),
        }));
        continue;
      }
      const registered = lane;
      all.set(tool.name, new sdk.ToolDefinition({ name: tool.name, description: tool.description,
        inputSchema, outputSchema, annotations: tool.annotations,
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
    if (scheduled) {
      for (const tool of scheduledAgentTools(scheduler, stored.id, scheduled, options.slackCheckerFactory)) all.set(tool.name, tool);
      // Exact selection: scheduled helpers do not inherit the normal product tool additions.
      return scheduled.tools.map(name => {
        if (name === 'switch_llm' && !all.has(name)) throw new Error('Scheduled agent switch_llm requires an enabled profile switch tool');
        const tool = all.get(name) ?? resolveProfileTool(name, lane.workingDir)[0];
        if (!tool) throw new Error(`Scheduled agent tool is unavailable: ${name}`);
        return tool;
      });
    }
    return [...all.values()];
  };
}
export interface RelayServerAppOptions extends Omit<AgentServerAppOptions, 'configureContext' | 'resolveProfileSelection' | 'resolveCondenserProfileSelection'> {
  context?: ProductContextOptions;
  models?: ProductModelOptions;
  scheduledAgents?: ScheduledAgentOptions;
  slackCheckerFactory?: SlackCheckerFactory;
}
export async function createRelayServerApp(options: RelayServerAppOptions = {}, scheduler = new TaskScheduler()): Promise<AgentServerApp & { scheduler: TaskScheduler }> {
  try {
    const { context, models, scheduledAgents, slackCheckerFactory, ...serverOptions } = options;
    const managedProfiles = serverOptions.agentFactory === undefined && serverOptions.conversationService === undefined;
    if (!managedProfiles && models !== undefined) throw new Error('Model configuration requires the profile agent factory');
    const selectCondenser = productCondenserProfileSelection(scheduler, models);
    const selectProfile = productProfileSelection(scheduler, { ...models, ...(scheduledAgents === undefined ? {} : { scheduledAgents }) });
    const server = await createAgentServerApp({ ...serverOptions, configureTools: productTools(scheduler, { scheduledAgents, slackCheckerFactory }), configureContext: productContext(scheduler, { ...context, ...(scheduledAgents === undefined ? {} : { scheduledAgents }) }),
      ...(managedProfiles ? { resolveProfileSelection: (factoryContext: Parameters<typeof selectProfile>[0]) => {
        productLane(scheduler, factoryContext.stored);
        return selectProfile(factoryContext);
      }, resolveCondenserProfileSelection: (factoryContext: Parameters<typeof selectCondenser>[0]) => {
        productLane(scheduler, factoryContext.stored);
        return selectCondenser(factoryContext);
      } } : {}) });
    server.app.addHook('onSend', async (_request, reply) => { reply.header('x-smolpaws-host', 'relay'); });
    server.app.addHook('onClose', async () => { scheduler.close(); });
    return { ...server, scheduler };
  } catch (error) { scheduler.close(); throw error; }
}
