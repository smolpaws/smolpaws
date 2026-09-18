import { z } from 'zod';
import type { ToolDefinition } from '../tool/index.js';
import { type LLMProfile, type Message } from './index.js';
export interface FetchResponseLike {
    readonly body?: {
        getReader(): {
            read(): Promise<{
                done: boolean;
                value?: Uint8Array;
            }>;
            cancel(): Promise<void>;
        };
    } | null;
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
export type FetchLike = (url: string, init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}) => Promise<FetchResponseLike>;
/** Stored SystemPromptEvent tools and executable tool definitions share a count boundary. */
export type LLMTokenCountTool = ToolDefinition | Readonly<Record<string, unknown>>;
export interface LLMClient {
    readonly profile: LLMProfile;
    /** Profile override first, then known metadata; null means unknown. No I/O in this getter. */
    readonly effectiveMaxInputTokens?: number | null;
    readonly tokenCountAccuracy?: 'estimate' | 'exact';
    /** Local estimates include system text and tools. Unknown modalities return null, never zero. */
    getTokenCount?(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    /** Resolve route metadata before reading the effective limit; failed discovery stays unknown. */
    resolveRuntimeMetadata?(): Promise<void>;
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare const llmUsageSchema: z.ZodObject<{
    promptTokens: z.ZodOptional<z.ZodNumber>;
    completionTokens: z.ZodOptional<z.ZodNumber>;
    totalTokens: z.ZodOptional<z.ZodNumber>;
    cacheReadTokens: z.ZodOptional<z.ZodNumber>;
    cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
    cacheMissTokens: z.ZodOptional<z.ZodNumber>;
    reasoningTokens: z.ZodOptional<z.ZodNumber>;
    toolUsePromptTokens: z.ZodOptional<z.ZodNumber>;
    providerUsage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    reportedCost: z.ZodOptional<z.ZodObject<{
        amount: z.ZodNumber;
        currency: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const llmResponseMetadataSchema: z.ZodObject<{
    usage: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
        cacheMissTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        toolUsePromptTokens: z.ZodOptional<z.ZodNumber>;
        providerUsage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        reportedCost: z.ZodOptional<z.ZodObject<{
            amount: z.ZodNumber;
            currency: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    responseId: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const llmCompletionResponseSchema: z.ZodObject<{
    usage: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
        cacheMissTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        toolUsePromptTokens: z.ZodOptional<z.ZodNumber>;
        providerUsage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        reportedCost: z.ZodOptional<z.ZodObject<{
            amount: z.ZodNumber;
            currency: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    responseId: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    message: z.ZodPipe<z.ZodObject<{
        role: z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"system">, z.ZodLiteral<"assistant">, z.ZodLiteral<"tool">]>;
        content: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
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
        }>>, z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"image">>;
            image_urls: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        }, {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
            enable_truncation?: boolean | undefined;
        }>>]>>, z.ZodNull]>>, z.ZodTransform<({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[], string | ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[] | null>>;
        tool_calls: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            name: z.ZodString;
            arguments: z.ZodString;
            origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
        }, z.core.$strict>>>>;
        tool_call_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        cache_enabled: z.ZodOptional<z.ZodBoolean>;
        vision_enabled: z.ZodOptional<z.ZodBoolean>;
        function_calling_enabled: z.ZodOptional<z.ZodBoolean>;
        force_string_serializer: z.ZodOptional<z.ZodBoolean>;
        send_reasoning_content: z.ZodOptional<z.ZodBoolean>;
        reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"thinking">>;
            thinking: z.ZodString;
            signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
            data: z.ZodString;
        }, z.core.$strict>]>>>;
        responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
            content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
            encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>, z.ZodTransform<{
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
    }, {
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
        cache_enabled?: boolean | undefined;
        vision_enabled?: boolean | undefined;
        function_calling_enabled?: boolean | undefined;
        force_string_serializer?: boolean | undefined;
        send_reasoning_content?: boolean | undefined;
    }>>;
    raw: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strict>;
export type LLMUsage = z.infer<typeof llmUsageSchema>;
export type LLMResponseMetadata = z.infer<typeof llmResponseMetadataSchema>;
export type LLMCompletionResponse = z.infer<typeof llmCompletionResponseSchema>;
/** A received provider response can be billable even when its content is invalid. */
export declare class LLMResponseError extends Error {
    readonly metadata: LLMResponseMetadata;
    constructor(metadata: LLMResponseMetadata, cause: unknown);
}
/** Extract accounting before validating message/tool content; never fabricate a message. */
export declare function parseLlmResponseWithMetadata(raw: unknown, parseMetadata: (raw: unknown) => LLMResponseMetadata, parseContent: (raw: unknown, metadata: LLMResponseMetadata) => LLMCompletionResponse): LLMCompletionResponse;
/** Retain available completion metadata on provider failure without an assistant message. */
export declare function throwProviderErrorWithMetadata(body: unknown, error: unknown, parseMetadata: (raw: unknown) => LLMResponseMetadata): never;
