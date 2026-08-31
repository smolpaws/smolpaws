import { describe, expect, test } from 'vitest';

import { resolveProfileTool } from '../profileAgentFactory.js';

const WORKING_DIR = '/tmp/workspace';

describe('resolveProfileTool', () => {
  test('resolves the upstream default tools', () => {
    for (const name of ['terminal', 'file_editor', 'glob', 'grep', 'finish', 'think']) {
      const [tool] = resolveProfileTool(name, WORKING_DIR);
      expect(tool?.name).toBe(name);
    }
  });

  test('resolves the SmolPaws send_message extension tool (EXT-SDK-001)', () => {
    const [tool] = resolveProfileTool('send_message', WORKING_DIR);
    expect(tool?.name).toBe('send_message');
  });

  test('resolves all five task-scheduler extension tools (EXT-SDK-002)', () => {
    for (const name of ['schedule_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task']) {
      const [tool] = resolveProfileTool(name, WORKING_DIR);
      expect(tool?.name).toBe(name);
    }
  });

  test('accepts a spec object with a name field', () => {
    const [tool] = resolveProfileTool({ name: 'send_message' }, WORKING_DIR);
    expect(tool?.name).toBe('send_message');
  });

  test('throws for an unknown tool', () => {
    expect(() => resolveProfileTool('nope', WORKING_DIR)).toThrow(/unsupported_profile_tool:nope/);
  });
});
