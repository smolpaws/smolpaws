import { z } from 'zod';
import { type ToolSpec } from './index.js';
export declare const classifyAndSwitchLLMParamsSchema: z.ZodObject<{
    active_meta_profile: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    meta_profile: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        classifier_model: z.ZodString;
        classes: z.ZodDefault<z.ZodArray<z.ZodObject<{
            description: z.ZodString;
            model: z.ZodString;
        }, z.core.$strict>>>;
        prompt_template: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        model_table: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
    meta_profile_llms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        profileId: z.ZodString;
        providerId: z.ZodString;
        model: z.ZodString;
        authType: z.ZodDefault<z.ZodEnum<{
            api_key: "api_key";
            subscription: "subscription";
        }>>;
        subscriptionVendor: z.ZodDefault<z.ZodNullable<z.ZodLiteral<"openai">>>;
        baseUrl: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        openAiApiMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"chat_completions">, z.ZodLiteral<"responses">]>>;
        temperature: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        topP: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        topK: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        maxInputTokens: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        maxOutputTokens: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        timeoutSeconds: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        streamIdleTimeoutSeconds: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        reasoningEffort: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>>;
        reasoningSummary: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"concise">, z.ZodLiteral<"detailed">]>>>;
        verbosity: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        cachingPrompt: z.ZodDefault<z.ZodBoolean>;
        anthropicCacheTtl: z.ZodOptional<z.ZodEnum<{
            "5m": "5m";
            "1h": "1h";
        }>>;
        promptCacheRetention: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"24h">, z.ZodLiteral<"disabled">]>>>;
        promptCacheKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        supportsPromptCacheKey: z.ZodOptional<z.ZodBoolean>;
        headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        useProfileKeyOverride: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
/** Validate every original explicit router spec before deduplication can hide it. */
export declare function validateToolSpecsForPersistence(tools: readonly unknown[]): ToolSpec[];
export declare const persistedToolSpecsSchema: z.ZodPreprocess<z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    params: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>>>;
