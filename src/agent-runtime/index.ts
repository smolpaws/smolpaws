import {
  runContainerAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../container-runner.js';
import { runSharedRunnerAgent } from './shared-runner.js';
import type { ExecutionScope } from '../scope.js';
import {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './workspace.js';

type AgentRuntimeBackend = 'container-stdio' | 'shared-runner';

interface AgentRuntime {
  run(scope: ExecutionScope, input: ContainerInput): Promise<ContainerOutput>;
  writeTasksSnapshot: typeof writeTasksSnapshot;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
}

class ContainerStdioAgentRuntime implements AgentRuntime {
  writeTasksSnapshot = writeTasksSnapshot;
  writeGroupsSnapshot = writeGroupsSnapshot;

  async run(scope: ExecutionScope, input: ContainerInput): Promise<ContainerOutput> {
    return await runContainerAgent(scope, input);
  }
}

class SharedRunnerAgentRuntime implements AgentRuntime {
  writeTasksSnapshot = writeTasksSnapshot;
  writeGroupsSnapshot = writeGroupsSnapshot;

  async run(scope: ExecutionScope, input: ContainerInput): Promise<ContainerOutput> {
    return await runSharedRunnerAgent(scope, input);
  }
}

let runtime: AgentRuntime | undefined;

function getConfiguredBackend(): AgentRuntimeBackend {
  const raw = process.env.SMOLPAWS_AGENT_RUNTIME_BACKEND?.trim();
  if (!raw || raw === 'container-stdio') {
    return 'container-stdio';
  }
  if (raw === 'shared-runner') {
    return 'shared-runner';
  }
  throw new Error(`Unsupported SMOLPAWS_AGENT_RUNTIME_BACKEND: ${raw}`);
}

function getAgentRuntime(): AgentRuntime {
  if (!runtime) {
    const backend = getConfiguredBackend();
    if (backend === 'container-stdio') {
      runtime = new ContainerStdioAgentRuntime();
    } else if (backend === 'shared-runner') {
      runtime = new SharedRunnerAgentRuntime();
    }
  }
  if (!runtime) {
    throw new Error('Failed to initialize agent runtime');
  }
  return runtime;
}

export async function runAgentRuntime(
  scope: ExecutionScope,
  input: ContainerInput
): Promise<ContainerOutput> {
  return await getAgentRuntime().run(scope, input);
}

export function writeRuntimeTasksSnapshot(
  scopeId: string,
  isControlScope: boolean,
  tasks: Array<{
    id: string;
    scopeId?: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  getAgentRuntime().writeTasksSnapshot(scopeId, isControlScope, tasks);
}

export function writeRuntimeGroupsSnapshot(
  scopeId: string,
  isControlScope: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  getAgentRuntime().writeGroupsSnapshot(scopeId, isControlScope, groups, registeredJids);
}

export type {
  AvailableGroup,
  ContainerInput as AgentRuntimeInput,
  ContainerOutput as AgentRuntimeOutput,
};
