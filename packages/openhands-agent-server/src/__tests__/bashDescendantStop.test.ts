import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { BashEventService } from '../bashService.js';
import { executeBashRequestSchema } from '../models.js';

test('stop drains a TERM-ignoring descendant even after the shell closes all inherited pipes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bash-detached-'));
  const service = new BashEventService({ bashEventsDir: path.join(root, 'events') });
  let childPid = 0;
  try {
    const pid = path.join(root, 'child.pid'), ready = path.join(root, 'ready');
    const running = await service.startBashCommand(executeBashRequestSchema.parse({
      command: `trap 'exit 0' TERM; bash -c 'trap "" TERM; echo $$ > "${pid}"; touch "${ready}"; exec sleep 30' >/dev/null 2>&1 & wait`,
      cwd: root, timeout: 20,
    }));
    await expect.poll(async () => { try { await access(ready); return true; } catch { return false; } }).toBe(true);
    childPid = Number(await readFile(pid, 'utf8'));
    expect(await service.stopBashCommand(running.command.id)).toBe(true);
    await running.task;
    await expect.poll(() => alive(childPid), { timeout: 500 }).toBe(false);
    const outputs = (await service.searchBashEvents({ commandId: running.command.id, kind: 'BashOutput' })).items;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ exit_code: 0 });
  } finally {
    if (childPid > 0) try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
