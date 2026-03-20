import { MAIN_GROUP_FOLDER } from './config.js';
import type { RegisteredGroup } from './types.js';

export function isControlScope(scopeFolder: string): boolean {
  return scopeFolder === MAIN_GROUP_FOLDER;
}

export function shouldRespondWithoutTrigger(scopeFolder: string): boolean {
  return isControlScope(scopeFolder);
}

export function canTargetScope(sourceScopeFolder: string, targetScopeFolder: string): boolean {
  return isControlScope(sourceScopeFolder) || sourceScopeFolder === targetScopeFolder;
}

export function canSendToChat(
  sourceScopeFolder: string,
  targetChatJid: string,
  registeredGroups: Record<string, RegisteredGroup>
): boolean {
  if (isControlScope(sourceScopeFolder)) {
    return true;
  }

  const targetGroup = registeredGroups[targetChatJid];
  return targetGroup?.folder === sourceScopeFolder;
}

export function canRefreshGroupMetadata(sourceScopeFolder: string): boolean {
  return isControlScope(sourceScopeFolder);
}

export function canRegisterGroup(sourceScopeFolder: string): boolean {
  return isControlScope(sourceScopeFolder);
}

export function filterVisibleTasks<T extends { scopeId?: string; groupFolder?: string }>(
  scopeFolder: string,
  tasks: T[]
): T[] {
  if (isControlScope(scopeFolder)) {
    return tasks;
  }

  return tasks.filter(task => (task.scopeId ?? task.groupFolder) === scopeFolder);
}

export function shouldExposeAvailableGroups(scopeFolder: string): boolean {
  return isControlScope(scopeFolder);
}
