import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const defaultChunkSize = 64 * 1024;

export async function pathContainsPlaintext(root: string, needle: string, chunkSize = defaultChunkSize): Promise<boolean> {
  if (needle.length === 0) return false;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await pathContainsPlaintext(fullPath, needle, chunkSize)) return true;
    } else if (entry.isFile() && await fileContainsPlaintext(fullPath, needle, chunkSize)) {
      return true;
    }
  }
  return false;
}

async function fileContainsPlaintext(filePath: string, needle: string, chunkSize: number): Promise<boolean> {
  const needleBytes = Buffer.from(needle, 'utf8');
  let previous = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(filePath, { highWaterMark: chunkSize })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const combined = Buffer.concat([previous, chunk]);
    if (combined.indexOf(needleBytes) !== -1) return true;
    previous = combined.subarray(Math.max(0, combined.length - needleBytes.length + 1));
  }
  return false;
}
