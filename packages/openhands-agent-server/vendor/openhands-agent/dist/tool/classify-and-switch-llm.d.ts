import { z } from 'zod';
import type { ConversationState } from '../conversation/state.js';
import type { Event } from '../event/index.js';
import type { LLMCallContext } from '../llm/call-context.js';
import { type LLMClient } from '../llm/client.js';
import { type LLMProfile, type Message } from '../llm/index.js';
import { MetaProfileStore, type MetaProfile, type MetaProfileInput } from '../meta-profiles/index.js';
import { ToolDefinition } from './index.js';
export declare const classifyAndSwitchLLMActionSchema: z.ZodObject<{}, z.core.$strict>;
export declare const classifyAndSwitchLLMObservationSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodLiteral<"ClassifyAndSwitchLLMObservation">>;
    content: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>>>;
    is_error: z.ZodDefault<z.ZodBoolean>;
    chosen_class: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    active_model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type ClassifyAndSwitchLLMAction = z.infer<typeof classifyAndSwitchLLMActionSchema>;
export type ClassifyAndSwitchLLMObservation = z.infer<typeof classifyAndSwitchLLMObservationSchema>;
export interface MetaProfileRoutingRuntime {
    readonly state: ConversationState;
    listProfileNames(): readonly string[] | Promise<readonly string[]>;
    /** Host resolves saved profile references/credentials; inline profiles use the same native factory. */
    resolveClient(name: string, inlineProfile?: LLMProfile): Promise<LLMClient>;
    /** Durably accept a pending selection without waiting for the step that is executing this tool. */
    switchProfile(name: string, inlineProfile?: LLMProfile): Promise<{
        model: string;
    }> | {
        model: string;
    };
    getCallContext(): LLMCallContext;
}
export interface ClassifyAndSwitchLLMToolOptions {
    readonly metaProfileStore?: Pick<MetaProfileStore, 'list' | 'load'>;
    readonly activeMetaProfile?: string | null;
    readonly metaProfile?: MetaProfileInput | null;
    readonly metaProfileLlms?: Readonly<Record<string, LLMProfile>>;
    readonly runtime?: MetaProfileRoutingRuntime;
}
export declare function buildClassifierPrompt(meta: MetaProfile): string;
export declare function parseClassIndex(text: string, numClasses: number): number;
export declare function renderDirectPrompt(meta: MetaProfile, instanceText: string): string;
export declare function buildClassifierMessages(meta: MetaProfile, transcript: string): Message[];
export declare function parseDirectModel(text: string, availableModels: readonly string[]): string | null;
export declare function recentMessagesText(events: readonly Event[], limit?: number): string;
export declare class ClassifyAndSwitchLLMTool {
    static readonly className = "ClassifyAndSwitchLLMTool";
    static create(options?: ClassifyAndSwitchLLMToolOptions): ToolDefinition<typeof classifyAndSwitchLLMActionSchema, typeof classifyAndSwitchLLMObservationSchema>;
}
