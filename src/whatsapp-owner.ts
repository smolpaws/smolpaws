/** One local process may own a linked WhatsApp device. Both host generations use this lock. */
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function acquireProcessOwner(authDir: string, label: string): () => void {
  mkdirSync(authDir, { recursive: true });
  const lock = path.join(realpathSync(authDir), '.smolpaws-owner');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = Number(readFileSync(path.join(lock, 'pid'), 'utf8')); }
      catch { throw new Error(`${label} is locked at ${lock}; inspect the owner before removing a stale lock`); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid ${label} owner lock: ${lock}`);
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { rmSync(lock, { recursive: true }); continue; }
        throw probe;
      }
      throw new Error(`${label} is already owned by process ${pid}`);
    }
    writeFileSync(path.join(lock, 'pid'), String(process.pid));
    return () => {
      try { if (readFileSync(path.join(lock, 'pid'), 'utf8') === String(process.pid)) rmSync(lock, { recursive: true }); }
      catch { /* Already released. */ }
    };
  }
  throw new Error(`Could not acquire ${label} ownership`);
}

export function acquireWhatsAppOwner(authDir: string): () => void { return acquireProcessOwner(authDir, 'WhatsApp device'); }
