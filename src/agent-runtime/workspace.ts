import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
} from '../config.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { ExecutionScope } from '../scope.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export function buildRunnerHostMounts(
  scope: ExecutionScope,
  isControl: boolean,
  options?: {
    projectRoot?: string;
  }
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = options?.projectRoot || process.cwd();

  mounts.push({
    hostPath: path.join(GROUPS_DIR, scope.workspaceFolder),
    containerPath: '/workspace/group',
    readonly: false,
  });

  if (isControl) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });
  } else {
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  const persistenceDir = path.join(DATA_DIR, 'runner-conversations', scope.scopeId);
  fs.mkdirSync(persistenceDir, { recursive: true });
  mounts.push({
    hostPath: persistenceDir,
    containerPath: '/workspace/persistence',
    readonly: false,
  });

  if (scope.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      scope.containerConfig.additionalMounts,
      scope.name,
      isControl,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}
