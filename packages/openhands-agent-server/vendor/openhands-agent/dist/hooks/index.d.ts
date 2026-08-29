import { type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { LLMClient } from '../llm/client.js';
export declare enum HookEventType {
    PreToolUse = "PreToolUse",
    PostToolUse = "PostToolUse",
    UserPromptSubmit = "UserPromptSubmit",
    SessionStart = "SessionStart",
    SessionEnd = "SessionEnd",
    Stop = "Stop"
}
export declare enum HookDecision {
    Allow = "allow",
    Deny = "deny"
}
export declare enum HookType {
    Command = "command",
    Prompt = "prompt",
    Agent = "agent"
}
declare const hookEventFieldNames: readonly ["pre_tool_use", "post_tool_use", "user_prompt_submit", "session_start", "session_end", "stop"];
export type HookEventFieldName = (typeof hookEventFieldNames)[number];
export declare const hookEventSchema: z.ZodObject<{
    event_type: z.ZodEnum<typeof HookEventType>;
    tool_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tool_input: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    tool_response: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    message: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    session_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    working_dir: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export type HookEvent = z.infer<typeof hookEventSchema>;
export interface HookDefinitionOptions {
    readonly type?: HookType | `${HookType}`;
    readonly name?: string | null;
    readonly command?: string;
    readonly prompt?: string | null;
    readonly system_prompt?: string | null;
    readonly tools?: readonly string[];
    readonly timeout?: number;
    readonly max_iterations?: number;
    readonly async?: boolean;
    readonly async_?: boolean;
}
export declare class HookDefinition {
    readonly type: HookType;
    readonly name: string | null;
    readonly command: string;
    readonly prompt: string | null;
    readonly system_prompt: string | null;
    readonly tools: string[];
    readonly timeout: number;
    readonly max_iterations: number;
    readonly async_: boolean;
    constructor(options: HookDefinitionOptions);
    get displayCommand(): string;
    toJSON(): Record<string, unknown>;
    private validate;
}
export interface HookMatcherOptions {
    readonly matcher?: string;
    readonly hooks?: readonly (HookDefinition | HookDefinitionOptions)[];
}
export declare class HookMatcher {
    readonly matcher: string;
    readonly hooks: HookDefinition[];
    constructor(options?: HookMatcherOptions);
    matches(toolName: string | null | undefined): boolean;
    toJSON(): Record<string, unknown>;
}
export type HookConfigInput = Partial<Record<HookEventFieldName | HookEventType, readonly HookMatcherOptions[]>> & {
    readonly hooks?: Record<string, readonly HookMatcherOptions[]>;
};
export declare class HookConfig {
    readonly pre_tool_use: HookMatcher[];
    readonly post_tool_use: HookMatcher[];
    readonly user_prompt_submit: HookMatcher[];
    readonly session_start: HookMatcher[];
    readonly session_end: HookMatcher[];
    readonly stop: HookMatcher[];
    constructor(input?: HookConfigInput);
    static fromObject(input: HookConfigInput): HookConfig;
    static load(options?: {
        readonly path?: string | null;
        readonly workingDir?: string | null;
    }): Promise<HookConfig>;
    isEmpty(): boolean;
    getHooksForEvent(eventType: HookEventType, toolName?: string | null): HookDefinition[];
    hasHooksForEvent(eventType: HookEventType): boolean;
    save(path: string): Promise<void>;
    toJSON(): Record<HookEventFieldName, unknown>;
    static merge(configs: readonly HookConfig[]): HookConfig | null;
    private matchersForEvent;
}
export declare class HookResult {
    readonly success: boolean;
    readonly blocked: boolean;
    readonly exit_code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly decision: HookDecision | null;
    readonly reason: string | null;
    readonly additionalContext: string | null;
    readonly error: string | null;
    readonly asyncStarted: boolean;
    constructor(options?: {
        readonly success?: boolean;
        readonly blocked?: boolean;
        readonly exit_code?: number;
        readonly stdout?: string;
        readonly stderr?: string;
        readonly decision?: HookDecision | null;
        readonly reason?: string | null;
        readonly additionalContext?: string | null;
        readonly error?: string | null;
        readonly asyncStarted?: boolean;
    });
    get shouldContinue(): boolean;
}
export declare class AsyncProcessManager {
    private readonly processes;
    addProcess(process: ChildProcess, timeoutSeconds: number): void;
    cleanupExpired(): void;
    cleanupAll(): void;
}
export declare class HookExecutor {
    readonly workingDir: string;
    readonly asyncProcessManager: AsyncProcessManager;
    private readonly llm;
    private readonly llmGetter;
    constructor(options?: {
        readonly workingDir?: string | null;
        readonly asyncProcessManager?: AsyncProcessManager | null;
        readonly llm?: LLMClient | null;
        readonly llmGetter?: (() => LLMClient | null) | null;
    });
    private resolveLlm;
    execute(hook: HookDefinition, event: HookEvent, env?: Record<string, string>): Promise<HookResult>;
    executePromptHook(hook: HookDefinition, event: HookEvent): Promise<HookResult>;
    private fallOpen;
    private parseDecision;
    executeAll(hooks: readonly HookDefinition[], event: HookEvent, env?: Record<string, string>, stopOnBlock?: boolean): Promise<HookResult[]>;
    private executeAsyncCommand;
    private executeCommand;
}
export declare class HookManager {
    readonly config: HookConfig;
    readonly executor: HookExecutor;
    readonly sessionId: string | null;
    readonly workingDir: string | null;
    constructor(options?: {
        readonly config?: HookConfig | null;
        readonly workingDir?: string | null;
        readonly sessionId?: string | null;
        readonly executor?: HookExecutor | null;
    });
    runPreToolUse(toolName: string, toolInput: Record<string, unknown>): Promise<{
        shouldContinue: boolean;
        results: HookResult[];
    }>;
    runPostToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: Record<string, unknown>): Promise<HookResult[]>;
    runUserPromptSubmit(message: string): Promise<{
        shouldContinue: boolean;
        additionalContext: string | null;
        results: HookResult[];
    }>;
    runStop(reason?: string | null): Promise<{
        shouldStop: boolean;
        results: HookResult[];
    }>;
    hasHooks(eventType: HookEventType): boolean;
    getBlockingReason(results: readonly HookResult[]): string | null;
    cleanupAsyncProcesses(): void;
    private event;
}
export {};
