import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveProfileTool } from '../profileAgentFactory.js';

const WORKING_DIR = '/tmp/workspace';

describe('resolveProfileTool', () => {
  test('the profile file editor can create and edit an absolute path outside its workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profile-editor-host-'));
    const workingDir = join(root, 'workspace');
    const target = join(root, 'private', 'note.md');
    try {
      await mkdir(workingDir);
      const [editor] = resolveProfileTool('file_editor', workingDir);
      expect(editor).toBeDefined();
      await expect(editor!.execute({ command: 'create', path: target, file_text: 'before\n' })).resolves.toMatchObject({ is_error: false });
      await expect(editor!.execute({ command: 'str_replace', path: target, old_str: 'before', new_str: 'after' })).resolves.toMatchObject({ is_error: false });
      expect(await readFile(target, 'utf8')).toBe('after\n');
      await expect(editor!.execute({ command: 'undo_edit', path: target })).resolves.toMatchObject({ is_error: false });
      expect(await readFile(target, 'utf8')).toBe('before\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resolves the upstream default tools', () => {
    for (const name of ['terminal', 'file_editor', 'glob', 'grep', 'finish', 'think']) {
      const [tool] = resolveProfileTool(name, WORKING_DIR);
      expect(tool?.name).toBe(name);
    }
  });

  test('resolves the SmolPaws send_message extension tool (EXT-SDK-001)', () => {
    expect(resolveProfileTool('send_media', WORKING_DIR)[0]?.name).toBe('send_media');
    const [tool] = resolveProfileTool('send_message', WORKING_DIR);
    expect(tool?.name).toBe('send_message');
  });

  test('resolves all task-scheduler extension tools (EXT-SDK-002)', () => {
    for (const name of ['schedule_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task', 'update_task']) {
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
