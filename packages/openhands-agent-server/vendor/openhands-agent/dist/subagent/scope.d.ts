import { z } from 'zod';
import { type ToolSpec } from '../tool/index.js';
export declare const SUB_AGENT_SCOPE_PARAM = "sub_agent_scope";
export declare const DELEGATION_TOOL_NAMES: readonly ["task_tool_set", "workflow_tool_set", "workflow"];
export declare const subAgentScopeSchema: z.ZodPipe<z.ZodObject<{
    tools: z.ZodDefault<z.ZodBoolean>;
    mcp_servers: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodTransform<{
    tools: boolean;
}, {
    tools: boolean;
    mcp_servers?: boolean | undefined;
}>>;
/** Host-supplied capabilities of the actual built agent, not merely its declared profile. */
export interface AgentCapabilitySnapshot {
    readonly tools: readonly string[];
    readonly includeDefaultTools?: readonly string[];
    readonly mcpConfig?: Readonly<Record<string, unknown>> | null;
}
/** Pure scope primitives. A delegation executor must enforce them before starting a child. */
export declare class SubAgentScope {
    readonly tools: boolean;
    constructor(data?: z.input<typeof subAgentScopeSchema>);
    get restricts(): boolean;
    missingFrom(parent: AgentCapabilitySnapshot, child: AgentCapabilitySnapshot): string[];
}
/** Snapshot helper only; delegated execution must apply it to the actual resolved parent. */
export declare function inheritMcpConfig<T extends AgentCapabilitySnapshot>(parent: AgentCapabilitySnapshot, child: T): T & {
    readonly mcpConfig: Readonly<Record<string, unknown>>;
};
export declare function scopeDelegationTools(tools: readonly ToolSpec[], scope: SubAgentScope): ToolSpec[];
