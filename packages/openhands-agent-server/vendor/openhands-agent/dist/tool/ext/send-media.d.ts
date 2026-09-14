/** EXT-SDK-001: outbound file intent. The host owns validation, spooling and delivery. */
import { z } from 'zod';
import { ToolDefinition } from '../index.js';
import { sendMessageObservationSchema } from './send-message.js';
export declare const sendMediaActionSchema: z.ZodObject<{
    path: z.ZodString;
    media_type: z.ZodEnum<{
        image: "image";
        video: "video";
        audio: "audio";
        document: "document";
    }>;
    caption: z.ZodOptional<z.ZodString>;
    mime_type: z.ZodOptional<z.ZodString>;
    voice_note: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare class SendMediaTool {
    static readonly className = "SendMediaTool";
    static create(): ToolDefinition<typeof sendMediaActionSchema, typeof sendMessageObservationSchema>;
}
