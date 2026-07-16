import { z } from 'zod';
import type { SecretRef, SecretStore } from '../secrets/index.js';
export declare const LLM_PROFILE_ID_PATTERN: RegExp;
export declare const llmProfileIdSchema: z.ZodString;
export declare const llmProviderIdSchema: z.ZodString;
export declare const openAiApiModeSchema: z.ZodUnion<readonly [z.ZodLiteral<"chat_completions">, z.ZodLiteral<"responses">]>;
export declare const reasoningEffortSchema: z.ZodUnion<readonly [z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>;
export declare const reasoningSummarySchema: z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"concise">, z.ZodLiteral<"detailed">]>;
export declare const promptCacheRetentionSchema: z.ZodUnion<readonly [z.ZodLiteral<"24h">, z.ZodLiteral<"disabled">]>;
export declare const llmProfileSchema: z.ZodObject<{
    profileId: z.ZodString;
    providerId: z.ZodString;
    model: z.ZodString;
    baseUrl: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    openAiApiMode: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"chat_completions">, z.ZodLiteral<"responses">]>>;
    temperature: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    topP: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    topK: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    maxInputTokens: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    maxOutputTokens: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    timeoutSeconds: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    reasoningEffort: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>>;
    reasoningSummary: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"concise">, z.ZodLiteral<"detailed">]>>>;
    promptCacheRetention: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"24h">, z.ZodLiteral<"disabled">]>>>;
    promptCacheKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    useProfileKeyOverride: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type LLMProfile = z.infer<typeof llmProfileSchema>;
export type OpenAiApiMode = z.infer<typeof openAiApiModeSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ReasoningSummary = z.infer<typeof reasoningSummarySchema>;
export type PromptCacheRetention = z.infer<typeof promptCacheRetentionSchema>;
export declare function resolveLlmProfileApiKeyRef(profile: LLMProfile, store: SecretStore): Promise<SecretRef | null>;
export declare const thinkingBlockSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"thinking">>;
    thinking: z.ZodString;
    signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const redactedThinkingBlockSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
    data: z.ZodString;
}, z.core.$strict>;
export declare const reasoningItemSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
    content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
    encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const textContentSchema: z.ZodPipe<z.ZodObject<{
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
}>>;
export declare const imageContentSchema: z.ZodPipe<z.ZodObject<{
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
}>>;
export declare const contentSchema: z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
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
}>>]>;
export declare const messageToolCallSchema: z.ZodObject<{
    id: z.ZodString;
    responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    name: z.ZodString;
    arguments: z.ZodString;
    origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
}, z.core.$strict>;
export declare const messageSchema: z.ZodPipe<z.ZodObject<{
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
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof redactedThinkingBlockSchema>;
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type ImageContent = z.infer<typeof imageContentSchema>;
export type Content = z.infer<typeof contentSchema>;
export type MessageToolCall = z.infer<typeof messageToolCallSchema>;
export type Message = z.infer<typeof messageSchema>;
export declare function textContent(text: string, cachePrompt?: boolean): TextContent;
export declare function imageContent(imageUrls: readonly string[], cachePrompt?: boolean): ImageContent;
export declare function reduceTextContent(message: Message): string;
export declare function contentToString(content: readonly Content[]): string[];
