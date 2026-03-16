import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
} from '../config.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { RegisteredGroup } from '../types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  options?: {
    projectRoot?: string;
  }
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = options?.projectRoot || process.cwd();

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  }

  const groupConversationsDir = path.join(DATA_DIR, 'conversations', group.folder);
  fs.mkdirSync(groupConversationsDir, { recursive: true });
  mounts.push({
    hostPath: groupConversationsDir,
    containerPath: '/workspace/conversations',
    readonly: false
  });

  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
    const filteredLines = envContent
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        return allowedVars.some(v => trimmed.startsWith(`${v}=`));
      });

    if (filteredLines.length > 0) {
      fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true
      });
    }
  }

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  void registeredJids;

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
