/** One local supervisor owns the shared child; bridge exits do not terminate it. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
export function superviseServer(command: string, args: string[], options: { delayMs?: number; onExit?: (code: number | null) => void } = {}): () => Promise<void> {
  let stopping = false; let child: ChildProcess; let timer: ReturnType<typeof setTimeout> | undefined;
  let ended: Promise<void>;
  const start = () => {
    child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', error => { console.error('Shared server could not start:', error.message); });
    ended = new Promise(resolve => child.once('close', code => {
      resolve(); options.onExit?.(code);
      if (!stopping) timer = setTimeout(start, options.delayMs ?? 2000);
    }));
  };
  start();
  return async () => {
    stopping = true; if (timer) clearTimeout(timer);
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { await ended; } finally { clearTimeout(deadline); }
  };
}
