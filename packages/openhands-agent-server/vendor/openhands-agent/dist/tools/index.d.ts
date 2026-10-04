import { z } from 'zod';
import { ToolDefinition } from '../tool/index.js';
export { MAX_CMD_OUTPUT_SIZE, terminalMetadataSchema } from './terminal-observation.js';
export declare const baseToolObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const terminalActionSchema: z.ZodObject<{
    command: z.ZodString;
    is_input: z.ZodDefault<z.ZodBoolean>;
    timeout: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    reset: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const terminalObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
    command: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    exit_code: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    timeout: z.ZodDefault<z.ZodBoolean>;
    metadata: z.ZodOptional<z.ZodObject<{
        exit_code: z.ZodDefault<z.ZodNumber>;
        pid: z.ZodDefault<z.ZodNumber>;
        username: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        hostname: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        working_dir: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        py_interpreter_path: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        prefix: z.ZodDefault<z.ZodString>;
        suffix: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>>;
    full_output_save_dir: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type TerminalAction = z.infer<typeof terminalActionSchema>;
export type TerminalObservation = z.infer<typeof terminalObservationSchema>;
/**
 * Hard cap applied when the model does not pass an explicit `timeout`. Upstream never blocks the agent
 * loop forever: its tmux executor returns to the model after 30s without output (soft timeout, exit code
 * -1). This executor cannot resume a still-running process, so it enforces a bounded hard timeout instead
 * and reports it as `timeout: true`. The model can raise the limit per command; an explicit `timeout: 0`
 * means no limit (Node's `exec` semantics), which is deliberate for commands with a known long duration.
 */
export declare const DEFAULT_TERMINAL_TIMEOUT_SECONDS = 300;
export declare class TerminalExecutor {
    readonly workingDir: string;
    readonly defaultTimeoutSeconds: number;
    constructor(options: {
        readonly workingDir: string;
        readonly defaultTimeoutSeconds?: number;
    });
    execute(action: TerminalAction): Promise<TerminalObservation>;
    private observation;
}
export declare class TerminalTool {
    static create(options: {
        readonly workingDir: string;
    }): ToolDefinition<typeof terminalActionSchema, typeof terminalObservationSchema>;
}
export type FileEditorCommand = 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit';
export declare const fileEditorActionSchema: z.ZodObject<{
    command: z.ZodEnum<{
        view: "view";
        create: "create";
        str_replace: "str_replace";
        insert: "insert";
        undo_edit: "undo_edit";
    }>;
    path: z.ZodString;
    file_text: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    old_str: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    new_str: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    insert_line: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    view_range: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodNumber>>>;
}, z.core.$strict>;
export declare const fileEditorObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
    command: z.ZodEnum<{
        view: "view";
        create: "create";
        str_replace: "str_replace";
        insert: "insert";
        undo_edit: "undo_edit";
    }>;
    path: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    prev_exist: z.ZodDefault<z.ZodBoolean>;
    old_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    new_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type FileEditorAction = z.infer<typeof fileEditorActionSchema>;
export type FileEditorObservation = z.infer<typeof fileEditorObservationSchema>;
export declare class FileEditorExecutor {
    private readonly history;
    readonly workspaceRoot: string | null;
    constructor(options?: {
        readonly workspaceRoot?: string | null;
    });
    execute(action: FileEditorAction): Promise<FileEditorObservation>;
    private resolvePath;
    private view;
    private create;
    private strReplace;
    private insert;
    private undo;
    private observation;
    private pushHistory;
}
export declare class FileEditorTool {
    static create(options?: {
        readonly workspaceRoot?: string | null;
    }): ToolDefinition<typeof fileEditorActionSchema, typeof fileEditorObservationSchema>;
}
export declare const globActionSchema: z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const globObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
    files: z.ZodDefault<z.ZodArray<z.ZodString>>;
    pattern: z.ZodString;
    search_path: z.ZodString;
    truncated: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type GlobAction = z.infer<typeof globActionSchema>;
export type GlobObservation = z.infer<typeof globObservationSchema>;
export declare class GlobExecutor {
    readonly workingDir: string;
    constructor(options: {
        readonly workingDir: string;
    });
    execute(action: GlobAction): Promise<GlobObservation>;
}
export declare class GlobTool {
    static create(options: {
        readonly workingDir: string;
    }): ToolDefinition<typeof globActionSchema, typeof globObservationSchema>;
}
export declare const grepActionSchema: z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    include: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    max_results: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const grepMatchSchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodNumber;
    text: z.ZodString;
}, z.core.$strict>;
export declare const grepObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
    matches: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strict>>;
    pattern: z.ZodString;
    search_path: z.ZodString;
    truncated: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type GrepAction = z.infer<typeof grepActionSchema>;
export type GrepObservation = z.infer<typeof grepObservationSchema>;
export declare class GrepExecutor {
    readonly workingDir: string;
    constructor(options: {
        readonly workingDir: string;
    });
    execute(action: GrepAction): Promise<GrepObservation>;
}
export declare class GrepTool {
    static create(options: {
        readonly workingDir: string;
    }): ToolDefinition<typeof grepActionSchema, typeof grepObservationSchema>;
}
export declare const taskItemSchema: z.ZodObject<{
    title: z.ZodString;
    notes: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        todo: "todo";
        in_progress: "in_progress";
        done: "done";
    }>>;
}, z.core.$strict>;
export declare const taskTrackerActionSchema: z.ZodObject<{
    command: z.ZodDefault<z.ZodEnum<{
        view: "view";
        plan: "plan";
    }>>;
    task_list: z.ZodDefault<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        notes: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<{
            todo: "todo";
            in_progress: "in_progress";
            done: "done";
        }>>;
    }, z.core.$strict>>>;
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
        status: z.ZodDefault<z.ZodEnum<{
            todo: "todo";
            in_progress: "in_progress";
            done: "done";
        }>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskTrackerAction = z.infer<typeof taskTrackerActionSchema>;
export type TaskTrackerObservation = z.infer<typeof taskTrackerObservationSchema>;
export declare class TaskTrackerExecutor {
    private taskList;
    readonly saveDir: string | null;
    constructor(options?: {
        readonly saveDir?: string | null;
    });
    execute(action: TaskTrackerAction): Promise<TaskTrackerObservation>;
    private saveTasks;
}
export declare class TaskTrackerTool {
    static create(options?: {
        readonly saveDir?: string | null;
    }): ToolDefinition<typeof taskTrackerActionSchema, typeof taskTrackerObservationSchema>;
}
export declare const browserActionSchema: z.ZodObject<{
    command: z.ZodEnum<{
        type: "type";
        navigate: "navigate";
        get_state: "get_state";
        click: "click";
        scroll: "scroll";
        back: "back";
    }>;
    url: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    index: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    text: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    direction: z.ZodDefault<z.ZodEnum<{
        up: "up";
        down: "down";
    }>>;
}, z.core.$strict>;
export declare const browserObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export interface BrowserAdapter {
    navigate?(url: string): Promise<z.infer<typeof browserObservationSchema>>;
    getState?(): Promise<z.infer<typeof browserObservationSchema>>;
    click?(index: number): Promise<z.infer<typeof browserObservationSchema>>;
    type?(index: number, text: string): Promise<z.infer<typeof browserObservationSchema>>;
    scroll?(direction: 'up' | 'down'): Promise<z.infer<typeof browserObservationSchema>>;
    back?(): Promise<z.infer<typeof browserObservationSchema>>;
}
export declare class BrowserTool {
    static create(options: {
        readonly adapter: BrowserAdapter;
    }): ToolDefinition<typeof browserActionSchema, typeof browserObservationSchema>;
}
