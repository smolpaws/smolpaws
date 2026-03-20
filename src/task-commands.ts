import { CronExpressionParser } from 'cron-parser';
import type pino from 'pino';
import { canTargetScope, filterVisibleTasks } from './control-scope.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.js';
import { TIMEZONE } from './config.js';
import type { RegisteredGroup } from './types.js';

export type SharedRunnerTaskCommand =
  | {
      kind: 'schedule_task';
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode: 'group' | 'isolated';
      target_scope_id?: string;
      source_scope_id?: string;
    }
  | {
      kind: 'pause_task' | 'resume_task' | 'cancel_task';
      task_id: string;
      source_scope_id?: string;
    };

export type VisibleTaskSnapshot = {
  id: string;
  scope_id: string;
  group_folder: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: string;
  next_run: string | null;
};

type LoggerLike = Pick<pino.Logger, 'info' | 'warn'>;

function resolveTargetChatJid(
  targetScopeId: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === targetScopeId,
  )?.[0];
}

function resolveNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
    return interval.next().toISOString();
  }
  if (scheduleType === 'interval') {
    const ms = Number.parseInt(scheduleValue, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error('invalid_interval');
    }
    return new Date(Date.now() + ms).toISOString();
  }
  const scheduled = new Date(scheduleValue);
  if (Number.isNaN(scheduled.getTime())) {
    throw new Error('invalid_timestamp');
  }
  return scheduled.toISOString();
}

export function buildVisibleTaskSnapshot(scopeId: string): VisibleTaskSnapshot[] {
  const tasks = getAllTasks().map((task) => ({
    id: task.id,
    scope_id: task.group_folder,
    scopeId: task.group_folder,
    group_folder: task.group_folder,
    groupFolder: task.group_folder,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    status: task.status,
    next_run: task.next_run,
  }));
  return filterVisibleTasks(scopeId, tasks).map(({ scopeId: _scopeId, groupFolder: _groupFolder, ...task }) => task);
}

export function processSharedRunnerTaskCommand(
  command: SharedRunnerTaskCommand,
  sourceScopeId: string,
  registeredGroups: Record<string, RegisteredGroup>,
  logger: LoggerLike,
): void {
  if (command.kind === 'schedule_task') {
    const targetScopeId = command.target_scope_id ?? sourceScopeId;
    if (!canTargetScope(sourceScopeId, targetScopeId)) {
      logger.warn(
        { sourceScopeId, targetScopeId },
        'Unauthorized shared-runner schedule_task attempt blocked',
      );
      return;
    }

    const targetChatJid = resolveTargetChatJid(targetScopeId, registeredGroups);
    if (!targetChatJid) {
      logger.warn(
        { sourceScopeId, targetScopeId },
        'Cannot schedule shared-runner task: target scope not registered',
      );
      return;
    }

    let nextRun: string | null;
    try {
      nextRun = resolveNextRun(command.schedule_type, command.schedule_value);
    } catch (error) {
      logger.warn(
        { sourceScopeId, targetScopeId, error: error instanceof Error ? error.message : String(error) },
        'Invalid shared-runner task schedule',
      );
      return;
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createTask({
      id: taskId,
      group_folder: targetScopeId,
      chat_jid: targetChatJid,
      prompt: command.prompt,
      schedule_type: command.schedule_type,
      schedule_value: command.schedule_value,
      context_mode: command.context_mode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info(
      { taskId, sourceScopeId, targetScopeId, contextMode: command.context_mode },
      'Task created via shared runner',
    );
    return;
  }

  const task = getTaskById(command.task_id);
  if (!task || !canTargetScope(sourceScopeId, task.group_folder)) {
    logger.warn(
      { taskId: command.task_id, sourceScopeId, kind: command.kind },
      'Unauthorized shared-runner task command blocked',
    );
    return;
  }

  if (command.kind === 'pause_task') {
    updateTask(command.task_id, { status: 'paused' });
    logger.info({ taskId: command.task_id, sourceScopeId }, 'Task paused via shared runner');
    return;
  }
  if (command.kind === 'resume_task') {
    updateTask(command.task_id, { status: 'active' });
    logger.info({ taskId: command.task_id, sourceScopeId }, 'Task resumed via shared runner');
    return;
  }

  deleteTask(command.task_id);
  logger.info({ taskId: command.task_id, sourceScopeId }, 'Task cancelled via shared runner');
}
