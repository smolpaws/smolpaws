/**
 * EXT-SDK-002 — task-scheduler tools (SmolPaws additive extension).
 *
 * SmolPaws' cross-conversation scheduling tools: `schedule_task`, `list_tasks`,
 * `cancel_task`, `pause_task`, `resume_task`. Each is an ordinary `ToolDefinition`
 * that records intent as an `ActionEvent`; the tools carry no scheduling engine and
 * perform no I/O. A downstream SmolPaws consumer (scheduler + coordinator) reads the
 * action and enqueues or mutates the actual schedule.
 *
 * This is distinct from the upstream-parity `task_tracker` tool (a per-conversation
 * checklist). Same word, different job.
 *
 * See docs/TRANSPILE_CONTRACT.md → Additive extensions. Target-only; not judged by
 * the upstream parity oracle.
 */
import { z } from 'zod';
import { ToolDefinition } from '../index.js';
export declare const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export declare const LIST_TASKS_TOOL_NAME = "list_tasks";
export declare const CANCEL_TASK_TOOL_NAME = "cancel_task";
export declare const PAUSE_TASK_TOOL_NAME = "pause_task";
export declare const RESUME_TASK_TOOL_NAME = "resume_task";
declare const taskObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const scheduleTaskActionSchema: z.ZodObject<{
    prompt: z.ZodString;
    schedule_type: z.ZodEnum<{
        cron: "cron";
        interval: "interval";
        once: "once";
    }>;
    schedule_value: z.ZodString;
    context_mode: z.ZodOptional<z.ZodEnum<{
        group: "group";
        isolated: "isolated";
    }>>;
    target_group: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type ScheduleTaskAction = z.infer<typeof scheduleTaskActionSchema>;
/**
 * Lightweight, dependency-free validity check for a schedule value. Full cron parsing is left to the
 * downstream scheduler; this only catches obvious mistakes so the model gets fast feedback.
 * Returns an error string, or null when the value looks acceptable.
 */
export declare function checkScheduleValue(action: Pick<ScheduleTaskAction, 'schedule_type' | 'schedule_value'>): string | null;
export declare class ScheduleTaskTool {
    static readonly className = "ScheduleTaskTool";
    static create(): ToolDefinition<typeof scheduleTaskActionSchema, typeof taskObservationSchema>;
}
export declare const listTasksActionSchema: z.ZodObject<{}, z.core.$strict>;
export declare class ListTasksTool {
    static readonly className = "ListTasksTool";
    static create(): ToolDefinition<typeof listTasksActionSchema, typeof taskObservationSchema>;
}
export declare const taskMutationActionSchema: z.ZodObject<{
    task_id: z.ZodString;
}, z.core.$strict>;
export type TaskMutationAction = z.infer<typeof taskMutationActionSchema>;
export declare class PauseTaskTool {
    static readonly className = "PauseTaskTool";
    static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema>;
}
export declare class ResumeTaskTool {
    static readonly className = "ResumeTaskTool";
    static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema>;
}
export declare class CancelTaskTool {
    static readonly className = "CancelTaskTool";
    static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema>;
}
/** All five task-scheduler tool factories, in a stable order. */
export declare const TASK_SCHEDULER_TOOL_FACTORIES: {
    readonly ScheduleTaskTool: () => ToolDefinition<z.ZodObject<{
        prompt: z.ZodString;
        schedule_type: z.ZodEnum<{
            cron: "cron";
            interval: "interval";
            once: "once";
        }>;
        schedule_value: z.ZodString;
        context_mode: z.ZodOptional<z.ZodEnum<{
            group: "group";
            isolated: "isolated";
        }>>;
        target_group: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    readonly ListTasksTool: () => ToolDefinition<z.ZodObject<{}, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    readonly PauseTaskTool: () => ToolDefinition<z.ZodObject<{
        task_id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    readonly ResumeTaskTool: () => ToolDefinition<z.ZodObject<{
        task_id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    readonly CancelTaskTool: () => ToolDefinition<z.ZodObject<{
        task_id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
};
export {};
