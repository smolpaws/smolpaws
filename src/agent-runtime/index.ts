import { runSharedRunnerAgent } from './shared-runner.js';
import type { ExecutionScope } from '../scope.js';
import type { RegisteredGroup } from '../types.js';
import type { AgentRuntimeInput, AgentRuntimeOutput } from './types.js';

export async function runAgentRuntime(
  scope: ExecutionScope,
  input: AgentRuntimeInput,
  options?: { registeredGroups?: Record<string, RegisteredGroup> },
): Promise<AgentRuntimeOutput> {
  return await runSharedRunnerAgent(scope, input, options);
}

export type { AgentRuntimeInput, AgentRuntimeOutput };
