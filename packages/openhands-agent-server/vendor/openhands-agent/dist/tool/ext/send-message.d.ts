/**
 * EXT-SDK-001 — outbound message tool (SmolPaws additive extension).
 *
 * This tool has no upstream counterpart. It lets the agent emit a mid-turn outbound
 * message as an ordinary `ActionEvent`; it records intent only and performs no delivery.
 * Delivery is owned by the SmolPaws coordinator, which projects the action into its
 * durable outbox. The tool does not end the turn — the agent keeps working after it.
 *
 * See docs/TRANSPILE_CONTRACT.md → Additive extensions. This file is target-only and is
 * not judged by the upstream parity oracle.
 */
import { z } from 'zod';
import { ToolDefinition } from '../index.js';
export declare const SEND_MESSAGE_TOOL_NAME = "send_message";
export declare const sendMessageActionSchema: z.ZodObject<{
    text: z.ZodString;
}, z.core.$strict>;
export declare const sendMessageObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type SendMessageAction = z.infer<typeof sendMessageActionSchema>;
export type SendMessageObservation = z.infer<typeof sendMessageObservationSchema>;
export declare class SendMessageTool {
    static readonly className = "SendMessageTool";
    static create(): ToolDefinition<typeof sendMessageActionSchema, typeof sendMessageObservationSchema>;
}
