import { z } from 'zod';
import { type Content } from '../llm/index.js';
export declare const MAX_CMD_OUTPUT_SIZE = 30000;
export declare const terminalMetadataSchema: z.ZodObject<{
    exit_code: z.ZodDefault<z.ZodNumber>;
    pid: z.ZodDefault<z.ZodNumber>;
    username: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    hostname: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    working_dir: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    py_interpreter_path: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    prefix: z.ZodDefault<z.ZodString>;
    suffix: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
/** Render terminal results at the replay boundary, including pre-cap saved events. */
export declare function terminalObservationContent(observation: Record<string, unknown>): Content[] | null;
