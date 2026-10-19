import { z } from 'zod';
import type { ToolSpec } from '../tool/index.js';
export declare const SUB_AGENT_SCOPE_PARAM = "sub_agent_scope";
export declare const DELEGATION_TOOL_NAMES: readonly ["task_tool_set", "workflow_tool_set", "workflow"];
export declare const subAgentScopeSchema: z.ZodObject<{
    tools: z.ZodDefault<z.ZodBoolean>;
    mcp_servers: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
/** Host-supplied capabilities of the actual built agent, not merely its declared profile. */
export interface AgentCapabilitySnapshot {
    readonly tools: readonly string[];
    readonly includeDefaultTools?: readonly string[];
    readonly mcpConfig?: Readonly<Record<string, unknown>> | null;
}
/** Pure scope primitives. A delegation executor must enforce them before starting a child. */
export declare class SubAgentScope {
    readonly tools: boolean;
    readonly mcp_servers: boolean;
    constructor(data?: z.input<typeof subAgentScopeSchema>);
    get restricts(): boolean;
    missingFrom(parent: AgentCapabilitySnapshot, child: AgentCapabilitySnapshot): string[];
}
export declare function scopeDelegationTools(tools: readonly ToolSpec[], scope: SubAgentScope): ToolSpec[];
