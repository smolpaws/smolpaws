/**
 * IPC Tools for SmolPaws
 * Writes messages and tasks to files for the host process to pick up
 */

import { ZodTool } from '@smolpaws/agent-sdk';
import type { ToolContext } from '@smolpaws/agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

// --- send_message ---

const sendMessageSchema = z.object({
  text: z.string().describe('The message text to send'),
});

class SendMessageTool extends ZodTool<z.infer<typeof sendMessageSchema>, { message: string }> {
  readonly name = 'send_message';
  readonly description = 'Send a message to the current WhatsApp group. Use this to proactively share information or updates.';
  readonly schema = sendMessageSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof sendMessageSchema>, _context: ToolContext): Promise<{ message: string }> {
    const data = {
      type: 'message',
      chatJid: this.ctx.chatJid,
      text: args.text,
      groupFolder: this.ctx.groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(MESSAGES_DIR, data);
    return { message: `Message queued for delivery (${filename})` };
  }
}

// --- schedule_task ---

const scheduleTaskSchema = z.object({
  prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
  schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
  schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
  context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
  target_group: z.string().optional().describe('Target group folder (control scope only, defaults to current group)'),
});

const SCHEDULE_TASK_DESCRIPTION = `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
- "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
- "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" -> group (needs conversation context)
- "Check the weather every morning" -> isolated (self-contained task)
- "Follow up on my request" -> group (needs to know what was requested)
- "Generate a daily report" -> isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
- cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
- interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
- once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`;

class ScheduleTaskTool extends ZodTool<z.infer<typeof scheduleTaskSchema>, { message: string }> {
  readonly name = 'schedule_task';
  readonly description = SCHEDULE_TASK_DESCRIPTION;
  readonly schema = scheduleTaskSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof scheduleTaskSchema>, _context: ToolContext): Promise<{ message: string }> {
    // Validate schedule_value
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return { message: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return { message: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return { message: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00".` };
      }
    }

    // Only the control scope can schedule on behalf of other scopes.
    const targetGroup = this.ctx.isMain && args.target_group ? args.target_group : this.ctx.groupFolder;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      groupFolder: targetGroup,
      chatJid: this.ctx.chatJid,
      createdBy: this.ctx.groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);
    return { message: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` };
  }
}

// --- list_tasks ---

const listTasksSchema = z.object({});

class ListTasksTool extends ZodTool<z.infer<typeof listTasksSchema>, { message: string }> {
  readonly name = 'list_tasks';
  readonly description = "List all scheduled tasks. From the control scope: shows all tasks. From other groups: shows only that group's tasks.";
  readonly schema = listTasksSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(_args: z.infer<typeof listTasksSchema>, _context: ToolContext): Promise<{ message: string }> {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { message: 'No scheduled tasks found.' };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = this.ctx.isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === this.ctx.groupFolder);

      if (tasks.length === 0) {
        return { message: 'No scheduled tasks found.' };
      }

      const formatted = tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
        `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
      ).join('\n');

      return { message: `Scheduled tasks:\n${formatted}` };
    } catch (err) {
      return { message: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// --- pause_task ---

const taskIdSchema = z.object({
  task_id: z.string().describe('The task ID'),
});

class PauseTaskTool extends ZodTool<z.infer<typeof taskIdSchema>, { message: string }> {
  readonly name = 'pause_task';
  readonly description = 'Pause a scheduled task. It will not run until resumed.';
  readonly schema = taskIdSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof taskIdSchema>, _context: ToolContext): Promise<{ message: string }> {
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder: this.ctx.groupFolder,
      isMain: this.ctx.isMain,
      timestamp: new Date().toISOString(),
    });
    return { message: `Task ${args.task_id} pause requested.` };
  }
}

// --- resume_task ---

class ResumeTaskTool extends ZodTool<z.infer<typeof taskIdSchema>, { message: string }> {
  readonly name = 'resume_task';
  readonly description = 'Resume a paused task.';
  readonly schema = taskIdSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof taskIdSchema>, _context: ToolContext): Promise<{ message: string }> {
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder: this.ctx.groupFolder,
      isMain: this.ctx.isMain,
      timestamp: new Date().toISOString(),
    });
    return { message: `Task ${args.task_id} resume requested.` };
  }
}

// --- cancel_task ---

class CancelTaskTool extends ZodTool<z.infer<typeof taskIdSchema>, { message: string }> {
  readonly name = 'cancel_task';
  readonly description = 'Cancel and delete a scheduled task.';
  readonly schema = taskIdSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof taskIdSchema>, _context: ToolContext): Promise<{ message: string }> {
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder: this.ctx.groupFolder,
      isMain: this.ctx.isMain,
      timestamp: new Date().toISOString(),
    });
    return { message: `Task ${args.task_id} cancellation requested.` };
  }
}

// --- register_group ---

const registerGroupSchema = z.object({
  jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
  name: z.string().describe('Display name for the group'),
  folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
  trigger: z.string().describe('Trigger word (e.g., "@smolpaws")'),
});

class RegisterGroupTool extends ZodTool<z.infer<typeof registerGroupSchema>, { message: string }> {
  readonly name = 'register_group';
  readonly description = `Register a new WhatsApp group so the agent can respond to messages there. Control scope only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`;
  readonly schema = registerGroupSchema;

  constructor(private ctx: IpcContext) { super(); }

  async execute(args: z.infer<typeof registerGroupSchema>, _context: ToolContext): Promise<{ message: string }> {
    if (!this.ctx.isMain) {
      return { message: 'Only the control scope can register new groups.' };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    });

    return { message: `Group "${args.name}" registered. It will start receiving messages immediately.` };
  }
}

// --- Factory ---

export function createIpcTools(ctx: IpcContext) {
  return [
    new SendMessageTool(ctx),
    new ScheduleTaskTool(ctx),
    new ListTasksTool(ctx),
    new PauseTaskTool(ctx),
    new ResumeTaskTool(ctx),
    new CancelTaskTool(ctx),
    new RegisterGroupTool(ctx),
  ];
}
