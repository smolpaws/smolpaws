import { z } from 'zod';
/**
 * Small, privacy-safe failure contract shared by SDK, UI, and telemetry.
 * ``detail`` is inspected locally only to map broad third-party errors to
 * this closed vocabulary; it is never copied into the classification.
 */
export declare const failureKindSchema: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
export type FailureKind = z.infer<typeof failureKindSchema>;
export declare const failureActionSchema: z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>;
export type FailureAction = z.infer<typeof failureActionSchema>;
export declare const errorClassificationSchema: z.ZodObject<{
    kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
    retryable: z.ZodBoolean;
    user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
    error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type ErrorClassification = z.infer<typeof errorClassificationSchema>;
/** Expected, agent-correctable failure — the agent can retry. */
export declare const AGENT_OUTCOME: ErrorClassification;
/**
 * Classify known failures from a typed code and local provider metadata text.
 *
 * Exception classes whose name alone is authoritative are checked first so
 * incidental wording in ``detail`` cannot override them; opaque/generic
 * wrapper codes are checked after the detail heuristics.
 */
export declare function classifyError(code: string, detail?: string): ErrorClassification;
