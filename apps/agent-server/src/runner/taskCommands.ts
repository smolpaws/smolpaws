import { CronExpressionParser } from 'cron-parser';
import type { ToolDefinition } from '@smolpaws/agent-sdk';
import type {
  SmolpawsConversationConfigValue,
  SmolpawsTaskCommand,
  SmolpawsVisibleTask,
} from '../shared/runner.js';

type ScheduleTaskArgs = {
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode?: 'group' | 'isolated';
  target_group?: string;
};

type TaskMutationArgs = {
  task_id: string;
};

type TaskToolOptions = {
  getConfig: () => SmolpawsConversationConfigValue | undefined;
  onCommand: (command: SmolpawsTaskCommand) => void | Promise<void>;
};

function resolveVisibleTasks(
  config: SmolpawsConversationConfigValue | undefined,
): SmolpawsVisibleTask[] {
  return Array.isArray(config?.visible_tasks) ? config.visible_tasks : [];
}

function formatVisibleTasks(tasks: SmolpawsVisibleTask[]): string {
  if (!tasks.length) {
    return 'No scheduled tasks found.';
  }
  const formatted = tasks.map((task) =>
    `- [${task.id}] ${task.prompt.slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run ?? 'N/A'}`,
  );
  return `Scheduled tasks:\n${formatted.join('\n')}`;
}

function validateScheduleArgs(args: ScheduleTaskArgs): string | null {
  if (args.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(args.schedule_value);
    } catch {
      return `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`;
    }
    return null;
  }
  if (args.schedule_type === 'interval') {
    const ms = Number.parseInt(args.schedule_value, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`;
    }
    return null;
  }
  const scheduled = new Date(args.schedule_value);
  if (Number.isNaN(scheduled.getTime())) {
    return `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00".`;
  }
  return null;
}

export function createTaskTools(
  options: TaskToolOptions,
): ToolDefinition<unknown, { message: string }>[] {
  const listTasksTool: ToolDefinition<never, { message: string }> = {
    name: 'list_tasks',
    description:
      'List scheduled tasks visible to the current scope. Control scopes can see all tasks; other scopes see only their own tasks.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    validate(): never {
      return undefined as never;
    },
    async execute(): Promise<{ message: string }> {
      return { message: formatVisibleTasks(resolveVisibleTasks(options.getConfig())) };
    },
  };

  const scheduleTaskTool: ToolDefinition<ScheduleTaskArgs, { message: string }> = {
    name: 'schedule_task',
    description: `Schedule a recurring or one-time task.

CONTEXT MODE:
- "group" keeps the current conversation context and memory
- "isolated" starts from a fresh session

SCHEDULE VALUE FORMAT:
- cron: "0 9 * * *"
- interval: milliseconds like "300000"
- once: local timestamp like "2026-02-01T15:30:00" (without Z)`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the agent should do when the task runs.',
        },
        schedule_type: {
          type: 'string',
          enum: ['cron', 'interval', 'once'],
        },
        schedule_value: {
          type: 'string',
          description: 'The cron expression, interval milliseconds, or once timestamp.',
        },
        context_mode: {
          type: 'string',
          enum: ['group', 'isolated'],
        },
        target_group: {
          type: 'string',
          description: 'Optional target scope id for control scopes.',
        },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
      additionalProperties: false,
    },
    validate(input: unknown): ScheduleTaskArgs {
      if (!input || typeof input !== 'object') {
        throw new Error('schedule_task requires an object argument');
      }
      const record = input as Record<string, unknown>;
      if (typeof record.prompt !== 'string' || !record.prompt.trim()) {
        throw new Error('schedule_task requires a non-empty prompt');
      }
      if (
        record.schedule_type !== 'cron' &&
        record.schedule_type !== 'interval' &&
        record.schedule_type !== 'once'
      ) {
        throw new Error('schedule_task requires schedule_type to be cron, interval, or once');
      }
      if (typeof record.schedule_value !== 'string' || !record.schedule_value.trim()) {
        throw new Error('schedule_task requires a non-empty schedule_value');
      }
      if (
        record.context_mode !== undefined &&
        record.context_mode !== 'group' &&
        record.context_mode !== 'isolated'
      ) {
        throw new Error('schedule_task context_mode must be group or isolated');
      }
      if (
        record.target_group !== undefined &&
        (typeof record.target_group !== 'string' || !record.target_group.trim())
      ) {
        throw new Error('schedule_task target_group must be a non-empty string when provided');
      }
      return {
        prompt: record.prompt.trim(),
        schedule_type: record.schedule_type,
        schedule_value: record.schedule_value.trim(),
        context_mode: record.context_mode as 'group' | 'isolated' | undefined,
        target_group:
          typeof record.target_group === 'string' ? record.target_group.trim() : undefined,
      };
    },
    async execute(args: ScheduleTaskArgs): Promise<{ message: string }> {
      const validationMessage = validateScheduleArgs(args);
      if (validationMessage) {
        return { message: validationMessage };
      }
      const config = options.getConfig();
      await options.onCommand({
        kind: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode ?? 'group',
        target_scope_id: args.target_group,
        source_scope_id: config?.scope_id,
      });
      return {
        message: `Task scheduled: ${args.schedule_type} - ${args.schedule_value}`,
      };
    },
  };

  function createTaskMutationTool(
    kind: 'pause_task' | 'resume_task' | 'cancel_task',
    description: string,
    successLabel: string,
  ): ToolDefinition<TaskMutationArgs, { message: string }> {
    return {
      name: kind,
      description,
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task id.',
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      validate(input: unknown): TaskMutationArgs {
        if (!input || typeof input !== 'object') {
          throw new Error(`${kind} requires an object argument`);
        }
        const taskId = (input as { task_id?: unknown }).task_id;
        if (typeof taskId !== 'string' || !taskId.trim()) {
          throw new Error(`${kind} requires a non-empty task_id`);
        }
        return { task_id: taskId.trim() };
      },
      async execute(args: TaskMutationArgs): Promise<{ message: string }> {
        const config = options.getConfig();
        await options.onCommand({
          kind,
          task_id: args.task_id,
          source_scope_id: config?.scope_id,
        });
        return { message: `Task ${args.task_id} ${successLabel}.` };
      },
    };
  }

  return [
    scheduleTaskTool,
    listTasksTool,
    createTaskMutationTool(
      'pause_task',
      'Pause a scheduled task. It will not run until resumed.',
      'pause requested',
    ),
    createTaskMutationTool(
      'resume_task',
      'Resume a paused task.',
      'resume requested',
    ),
    createTaskMutationTool(
      'cancel_task',
      'Cancel and delete a scheduled task.',
      'cancellation requested',
    ),
  ];
}
