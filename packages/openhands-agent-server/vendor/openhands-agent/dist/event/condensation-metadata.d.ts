import { z } from 'zod';
/** EXT-SDK-004: request provenance is durable; it is not inferred from a boolean. */
export declare const condensationRequestDetailsSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    trigger: z.ZodLiteral<"agent">;
    action_id: z.ZodString;
    observation_id: z.ZodString;
    version: z.ZodLiteral<1>;
    input_event_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>, z.ZodObject<{
    trigger: z.ZodLiteral<"provider_context_window">;
    protected_user_event_ids: z.ZodArray<z.ZodString>;
    version: z.ZodLiteral<1>;
    input_event_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>], "trigger">;
/** One Condensation is the commit; references resolve against the append-only log. */
export declare const condensationResetSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    request_id: z.ZodString;
}, z.core.$strict>;
export declare const condensationOperationFailureSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    request_id: z.ZodString;
    error: z.ZodString;
}, z.core.$strict>;
export type CondensationRequestDetails = z.infer<typeof condensationRequestDetailsSchema>;
