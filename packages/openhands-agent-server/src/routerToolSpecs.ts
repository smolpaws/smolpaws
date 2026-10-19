import { isDeepStrictEqual } from 'node:util';

import { ClassifyAndSwitchLLMTool, resolveTool, toolSpecSchema, type ToolSpec } from '@smolpaws/openhands-agent';
import { z } from 'zod';

export function isRouterToolName(name: unknown): boolean {
  return name === 'route_task_to_model' || name === ClassifyAndSwitchLLMTool.className;
}

/** Validate before any request, settings or agent-profile payload is persisted. */
export function validateRouterToolSpecs(settings: { readonly tools?: readonly unknown[] | null }): void {
  selectRouterToolSpec(settings.tools ?? []);
}

/** Parameterized explicit specs outrank bare aliases and the injected default.
 * Conflicting explicit configurations are rejected; no input silently wins. */
export function selectRouterToolSpec(tools: readonly unknown[]): ToolSpec | undefined {
  let selected: ToolSpec | undefined;
  try {
    for (const candidate of tools) {
      const name = typeof candidate === 'string' ? candidate
        : typeof candidate === 'object' && candidate !== null && 'name' in candidate ? candidate.name : undefined;
      if (!isRouterToolName(name)) continue;
      const spec = toolSpecSchema.parse(typeof candidate === 'string' ? { name: candidate } : candidate);
      // SDK construction validates strict snake_case params and safe inline LLM
      // profiles. It performs no store reads, credential lookups or completions.
      resolveTool(spec);
      if (selected === undefined || Object.keys(selected.params).length === 0) selected = spec;
      else if (Object.keys(spec.params).length > 0 && !isDeepStrictEqual(selected.params, spec.params)) throw new Error('conflicting router parameters');
    }
  } catch {
    throw new z.ZodError([{ code: 'custom', path: ['tools'], message: 'Invalid or conflicting routing tool parameters.' }]);
  }
  return selected;
}
