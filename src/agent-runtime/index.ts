import {
  runContainerAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';
import {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './workspace.js';

type AgentRuntimeBackend = 'container-stdio';

interface AgentRuntime {
  run(group: RegisteredGroup, input: ContainerInput): Promise<ContainerOutput>;
  writeTasksSnapshot: typeof writeTasksSnapshot;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
}

class ContainerStdioAgentRuntime implements AgentRuntime {
  writeTasksSnapshot = writeTasksSnapshot;
  writeGroupsSnapshot = writeGroupsSnapshot;

  async run(group: RegisteredGroup, input: ContainerInput): Promise<ContainerOutput> {
    return await runContainerAgent(group, input);
  }
}

let runtime: AgentRuntime | undefined;

function getConfiguredBackend(): AgentRuntimeBackend {
  const raw = process.env.SMOLPAWS_AGENT_RUNTIME_BACKEND?.trim();
  if (!raw || raw === 'container-stdio') {
    return 'container-stdio';
  }
  throw new Error(`Unsupported SMOLPAWS_AGENT_RUNTIME_BACKEND: ${raw}`);
}

function getAgentRuntime(): AgentRuntime {
  if (!runtime) {
    const backend = getConfiguredBackend();
    if (backend === 'container-stdio') {
      runtime = new ContainerStdioAgentRuntime();
    }
  }
  if (!runtime) {
    throw new Error('Failed to initialize agent runtime');
  }
  return runtime;
}

export async function runAgentRuntime(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  return await getAgentRuntime().run(group, input);
}

export function writeRuntimeTasksSnapshot(
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
  getAgentRuntime().writeTasksSnapshot(groupFolder, isMain, tasks);
}

export function writeRuntimeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  getAgentRuntime().writeGroupsSnapshot(groupFolder, isMain, groups, registeredJids);
}

export type {
  AvailableGroup,
  ContainerInput as AgentRuntimeInput,
  ContainerOutput as AgentRuntimeOutput,
};
