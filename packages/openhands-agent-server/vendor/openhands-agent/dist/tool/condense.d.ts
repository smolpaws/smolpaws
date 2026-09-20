import { z } from 'zod';
import { ToolDefinition } from './index.js';
export declare const condenseActionSchema: z.ZodObject<{
    message_to_future_self: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const condenseObservationSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodLiteral<"CondenseObservation">>;
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
    request_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    message_to_future_self: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type CondenseAction = z.infer<typeof condenseActionSchema>;
export type CondenseObservation = z.infer<typeof condenseObservationSchema>;
export interface CondenseExecutionContext {
    /** Persist the request; the agent applies the reset after the tool result is durable. */
    requestCondensation(action: CondenseAction): CondenseObservation | Promise<CondenseObservation>;
}
/** Opt-in tool; the agent-reset runtime supplies its execution context. */
export declare class CondenseTool {
    static readonly className = "CondenseTool";
    static create(): ToolDefinition<typeof condenseActionSchema, typeof condenseObservationSchema>;
}
