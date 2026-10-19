import { z } from 'zod';
export * from './defaults.js';
export * from './module-qualnames.js';
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
    /** The implementation accesses only its own conversation's state. */
    readonly conversationLocal?: boolean;
    /** Runtime prompt text; excluded from tool wire schemas and JSON persistence. */
    readonly promptGuidance?: string | null;
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
    readonly conversationLocal: boolean;
    readonly promptGuidance: string | null;
    constructor(options: ToolDefinitionOptions<TInputSchema, TOutputSchema>);
    execute(input: unknown, context?: unknown): Promise<z.infer<TOutputSchema>>;
    toMcpTool(inputSchema?: JsonObject, outputSchema?: JsonObject): McpTool;
    toResponsesTool(): ResponsesTool;
}
export interface ToolCatalogMetadata {
    readonly userSelectable?: boolean;
    readonly catalogDescription?: string;
    readonly isUsable?: () => boolean;
    /** Trusted protocol provenance for this exact implementation; never imported. */
    readonly moduleQualname?: string;
    readonly conversationLocal?: boolean;
    /** Marks a registration of the actual builtin, rather than a host override. */
    readonly builtinName?: string;
}
export interface BuiltinToolMetadata extends ToolCatalogMetadata {
    readonly canonicalName?: string;
    readonly acceptsParams?: boolean;
}
export interface ToolCatalogEntry {
    readonly name: string;
    readonly user_selectable: boolean;
    readonly usable: boolean;
    readonly description: string;
    readonly in_default_set: boolean;
}
export declare class ToolRegistry {
    private readonly registrations;
    private sealedRegistrations;
    private sealedBuiltins;
    register(name: string, tool: ToolDefinition, metadata?: ToolCatalogMetadata): void;
    registerFactory(name: string, factory: ToolFactory, metadata?: ToolCatalogMetadata): void;
    effectiveBuiltinName(name: string): string | null;
    canonicalToolName(name: string): string;
    resolve(spec: ToolSpec, context?: unknown): readonly ToolDefinition[];
    listRegisteredTools(): readonly string[];
    /**
     * Snapshot live resolver provenance, independent of the sealed UI catalog.
     * Pass finalized selected names (excluding client tools) for server persistence.
     * A host override without metadata deliberately hides builtin provenance.
     */
    getToolModuleQualnames(names?: readonly string[]): Readonly<Record<string, string>>;
    /** Use the effective implementation, without constructing a factory or inheriting a shadowed builtin. */
    isConversationLocalTool(name: string): boolean;
    listUsableTools(): readonly string[];
    isToolAvailable(name: string, options?: {
        readonly checkUsable?: boolean;
    }): boolean;
    sealToolCatalog(): void;
    unsealToolCatalog(): void;
    getToolCatalog(options?: {
        readonly checkUsable?: boolean;
    }): ToolCatalogEntry[];
}
export declare const globalToolRegistry: ToolRegistry;
export declare function registerTool(name: string, tool: ToolDefinition, metadata?: ToolCatalogMetadata): void;
export declare function registerToolFactory(name: string, factory: ToolFactory, metadata?: ToolCatalogMetadata): void;
export declare function resolveTool(spec: ToolSpec, context?: unknown): readonly ToolDefinition[];
export declare function listRegisteredTools(): readonly string[];
export declare function getToolModuleQualnames(names?: readonly string[]): Readonly<Record<string, string>>;
export declare function isConversationLocalTool(name: string): boolean;
export declare function listUsableTools(): readonly string[];
/** Resolver fallbacks do not construct tools while cataloging availability. */
type BuiltInResolver = (params: Readonly<Record<string, unknown>>, context?: unknown) => readonly ToolDefinition[];
export declare function registerBuiltinResolver(name: string, resolver: BuiltInResolver, metadata?: BuiltinToolMetadata): void;
export declare function getToolCatalog(options?: {
    readonly checkUsable?: boolean;
}): ToolCatalogEntry[];
export declare function isToolAvailable(name: string, options?: {
    readonly checkUsable?: boolean;
}): boolean;
export declare function sealToolCatalog(): void;
export declare function unsealToolCatalog(): void;
export declare function assertSupportedResponseSchema(params: Readonly<Record<string, unknown>>): void;
