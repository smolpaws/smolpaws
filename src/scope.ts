import { isControlScope } from './control-scope.js';
import type { RegisteredGroup } from './types.js';

export interface ExecutionScope {
  kind: 'whatsapp';
  scopeId: string;
  name: string;
  workspaceFolder: string;
  chatJid: string;
  trigger: string;
  isControlScope: boolean;
  containerConfig?: RegisteredGroup['containerConfig'];
}

export function scopeFromRegisteredGroup(chatJid: string, group: RegisteredGroup): ExecutionScope {
  return {
    kind: 'whatsapp',
    scopeId: group.folder,
    name: group.name,
    workspaceFolder: group.folder,
    chatJid,
    trigger: group.trigger,
    isControlScope: isControlScope(group.folder),
    containerConfig: group.containerConfig,
  };
}

export function findScopeByFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  scopeId: string
): ExecutionScope | undefined {
  const entry = Object.entries(registeredGroups).find(([, group]) => group.folder === scopeId);
  if (!entry) {
    return undefined;
  }

  const [chatJid, group] = entry;
  return scopeFromRegisteredGroup(chatJid, group);
}
