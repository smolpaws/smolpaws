import { z } from 'zod';
export * from './defaults.js';
export type JsonObject = Record<string, unknown>;
export type ToolExecutor<TAction = unknown, TObservation = unknown> = (action: TAction, context?: unknown) => TObservation | Promise<TObservation>;
export type ToolFactory = (params: Readonly<Record<string, unknown>>, context?: unknown) => readonly ToolDefinition[];
export declare const toolAnnotationsSchema: z.ZodObject<{
    title: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    readOnlyHint: z.ZodDefault<z.ZodBoolean>;
    destructiveHint: z.ZodDefault<z.ZodBoolean>;
    idempotentHint: z.ZodDefault<z.ZodBoolean>;
    openWorldHint: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const toolSpecSchema: z.ZodObject<{
    name: z.ZodString;
    params: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolSpec = z.infer<typeof toolSpecSchema>;
export interface ToolDefinitionOptions<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly outputSchema?: TOutputSchema;
    readonly executor?: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>>;
    readonly annotations?: ToolAnnotations;
    readonly meta?: JsonObject;
    readonly usable?: boolean;
}
export interface McpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly outputSchema?: JsonObject;
    readonly annotations?: ToolAnnotations;
    readonly _meta?: JsonObject;
}
export interface ResponsesTool {
    readonly type: 'function';
    readonly name: string;
    readonly description?: string;
    readonly strict: false;
    readonly parameters: JsonObject;
}
export declare class ToolDefinition<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly outputSchema: TOutputSchema | undefined;
    readonly executor: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>> | undefined;
    readonly annotations: ToolAnnotations | undefined;
    readonly meta: JsonObject | undefined;
    readonly usable: boolean;
    constructor(options: ToolDefinitionOptions<TInputSchema, TOutputSchema>);
    execute(input: unknown, context?: unknown): Promise<z.infer<TOutputSchema>>;
    toMcpTool(inputSchema?: JsonObject, outputSchema?: JsonObject): McpTool;
    toResponsesTool(): ResponsesTool;
}
export declare class ToolRegistry {
    private readonly registrations;
    register(name: string, tool: ToolDefinition): void;
    registerFactory(name: string, factory: ToolFactory): void;
    resolve(spec: ToolSpec, context?: unknown): readonly ToolDefinition[];
    listRegisteredTools(): readonly string[];
    listUsableTools(): readonly string[];
}
export declare const globalToolRegistry: ToolRegistry;
export declare function registerTool(name: string, tool: ToolDefinition): void;
export declare function registerToolFactory(name: string, factory: ToolFactory): void;
export declare function resolveTool(spec: ToolSpec, context?: unknown): readonly ToolDefinition[];
export declare function listRegisteredTools(): readonly string[];
export declare function listUsableTools(): readonly string[];
