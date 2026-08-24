import { type Content } from '../llm/index.js';
export declare class MCPError extends Error {
}
export declare class MCPTimeoutError extends MCPError {
    readonly timeout: number;
    readonly config: Record<string, unknown> | null;
    constructor(message: string, timeout: number, config?: Record<string, unknown> | null);
}
export interface McpTextContentBlock {
    readonly type: 'text';
    readonly text: string;
}
export interface McpImageContentBlock {
    readonly type: 'image';
    readonly mimeType: string;
    readonly data: string;
}
export type McpContentBlock = McpTextContentBlock | McpImageContentBlock | Record<string, unknown>;
export interface McpCallToolResult {
    readonly content: readonly McpContentBlock[];
    readonly isError?: boolean;
}
export interface McpToolSpec {
    readonly name: string;
    readonly description?: string | null;
    readonly inputSchema?: Record<string, unknown>;
    readonly annotations?: Record<string, unknown> | null;
    readonly meta?: Record<string, unknown> | null;
}
export interface McpClientLike {
    isConnected(): boolean;
    connect?(): Promise<void> | void;
    readonly closed?: boolean;
    callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallToolResult>;
}
export declare class MCPToolAction {
    readonly data: Record<string, unknown>;
    constructor(data?: Record<string, unknown>);
    toMcpArguments(): Record<string, unknown>;
}
export declare class MCPToolObservation {
    readonly content: Content[];
    readonly is_error: boolean;
    readonly tool_name: string;
    constructor(options: {
        readonly content: readonly Content[];
        readonly is_error?: boolean;
        readonly tool_name: string;
    });
    static fromText(text: string, options: {
        readonly is_error?: boolean;
        readonly tool_name: string;
    }): MCPToolObservation;
    static fromCallToolResult(toolName: string, result: McpCallToolResult): MCPToolObservation;
    visualize(): string;
}
export declare class MCPToolExecutor {
    readonly toolName: string;
    readonly client: McpClientLike;
    readonly timeoutSeconds: number;
    constructor(toolName: string, client: McpClientLike, timeoutSeconds?: number);
    execute(action: MCPToolAction): Promise<MCPToolObservation>;
}
export declare class MCPToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations: Record<string, unknown> | null;
    readonly meta: Record<string, unknown> | null;
    readonly executor: MCPToolExecutor;
    constructor(spec: McpToolSpec, client: McpClientLike);
    static create(spec: McpToolSpec, client: McpClientLike): MCPToolDefinition[];
    actionFromArguments(arguments_: Record<string, unknown>): MCPToolAction;
    toMcpTool(inputSchema?: Record<string, unknown> | null, outputSchema?: Record<string, unknown> | null): Record<string, unknown>;
    toOpenAiTool(): Record<string, unknown>;
    toResponsesTool(): Record<string, unknown>;
}
export declare function toCamelCase(value: string): string;
export declare function createMcpTools(config: Record<string, unknown>, clientFactory: (config: Record<string, unknown>) => {
    readonly tools: readonly MCPToolDefinition[];
}): {
    readonly tools: readonly MCPToolDefinition[];
};
