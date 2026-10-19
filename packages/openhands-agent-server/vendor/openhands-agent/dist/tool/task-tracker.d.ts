import { z } from 'zod';
import { ToolDefinition } from './index.js';
export declare const taskItemSchema: z.ZodObject<{
    title: z.ZodString;
    notes: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodPreprocess<z.ZodEnum<{
        todo: "todo";
        in_progress: "in_progress";
        done: "done";
    }>>>;
}, z.core.$strip>;
export declare const taskTrackerActionSchema: z.ZodObject<{
    command: z.ZodDefault<z.ZodEnum<{
        view: "view";
        plan: "plan";
    }>>;
    task_list: z.ZodDefault<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        notes: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodPreprocess<z.ZodEnum<{
            todo: "todo";
            in_progress: "in_progress";
            done: "done";
        }>>>;
    }, z.core.$strip>>>;
}, z.core.$strict>;
export declare const taskTrackerObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
    command: z.ZodEnum<{
        view: "view";
        plan: "plan";
    }>;
    task_list: z.ZodDefault<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        notes: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodPreprocess<z.ZodEnum<{
            todo: "todo";
            in_progress: "in_progress";
            done: "done";
        }>>>;
    }, z.core.$strip>>>;
}, z.core.$strict>;
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskTrackerAction = z.input<typeof taskTrackerActionSchema>;
export type TaskTrackerObservation = z.infer<typeof taskTrackerObservationSchema>;
export declare class TaskTrackerExecutor {
    private taskList;
    private readonly saveDir;
    private ready;
    constructor(options?: {
        readonly saveDir?: string | null;
    });
    execute(action: TaskTrackerAction): Promise<TaskTrackerObservation>;
    private loadTasks;
    private saveTasks;
}
export declare class TaskTrackerTool {
    static create(options?: {
        readonly saveDir?: string | null;
    }): ToolDefinition<typeof taskTrackerActionSchema, typeof taskTrackerObservationSchema>;
}
