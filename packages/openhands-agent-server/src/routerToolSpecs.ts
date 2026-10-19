import { ClassifyAndSwitchLLMTool, validateToolSpecsForPersistence, type ToolSpec } from '@smolpaws/openhands-agent';
import { z } from 'zod';

export function isRouterToolName(name: unknown): boolean {
  return name === 'route_task_to_model' || name === ClassifyAndSwitchLLMTool.className;
}

/** Validate before any request, settings or agent-profile payload is persisted. */
export function validateRouterToolSpecs(settings: { readonly tools?: readonly unknown[] | null }): void {
  selectRouterToolSpec(settings.tools ?? []);
}

/** Validate every original router before canonical first-parameterized-wins merging. */
export function selectRouterToolSpec(tools: readonly unknown[]): ToolSpec | undefined {
  try {
    const candidates = tools.filter(candidate => {
      const name = typeof candidate === 'string' ? candidate
        : typeof candidate === 'object' && candidate !== null && 'name' in candidate ? candidate.name : undefined;
      return isRouterToolName(name);
    });
    return validateToolSpecsForPersistence(candidates)[0];
  } catch {
    throw new z.ZodError([{ code: 'custom', path: ['tools'], message: 'Invalid routing tool parameters.' }]);
  }
}
