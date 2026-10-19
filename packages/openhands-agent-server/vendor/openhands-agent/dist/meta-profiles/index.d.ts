import { z } from 'zod';
/** Each model reference is a saved profile name, never an unconfigured model ID. */
export declare const metaProfileClassSchema: z.ZodObject<{
    description: z.ZodString;
    model: z.ZodString;
}, z.core.$strict>;
export declare const metaProfileSchema: z.ZodObject<{
    classifier_model: z.ZodString;
    classes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        description: z.ZodString;
        model: z.ZodString;
    }, z.core.$strict>>>;
    prompt_template: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    model_table: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
/** Inline/cloud profiles retain the native profile and SecretStore boundary. */
export declare const metaProfileLlmsSchema: z.ZodRecord<z.ZodString, z.ZodObject<{
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
}, z.core.$strict>>;
export type MetaProfileClass = z.infer<typeof metaProfileClassSchema>;
export type MetaProfile = z.infer<typeof metaProfileSchema>;
export type MetaProfileInput = z.input<typeof metaProfileSchema>;
export interface MetaProfileSummary {
    readonly name: string;
    /** Summaries deliberately do not require the complete stored schema to validate. */
    readonly classifier_model: unknown;
    readonly num_classes: number;
}
export declare class MetaProfileLimitExceeded extends Error {
    constructor(maxProfiles: number);
}
export declare class MetaProfileStoreTimeoutError extends Error {
    readonly code = "ETIMEDOUT";
    constructor(timeoutSeconds: number, cause: unknown);
}
export declare function defaultMetaProfileDir(): string;
/** Fresh UTF-8 reads and atomic replacement; mutation limits are checked under a process-shared lock. */
export declare class MetaProfileStore {
    readonly baseDir: string;
    private readonly lockStore;
    private readonly lockTimeoutSeconds;
    private mutationTail;
    constructor(baseDir?: string, options?: {
        readonly lockTimeoutSeconds?: number;
    });
    list(): Promise<string[]>;
    load(name: string): Promise<MetaProfile>;
    save(name: string, profile: unknown, options?: {
        readonly maxProfiles?: number | null;
    }): Promise<void>;
    delete(name: string): Promise<void>;
    listSummaries(): Promise<MetaProfileSummary[]>;
    private filePath;
    private mutate;
}
