import { RouterError } from './types.js';

export class MutationError extends RouterError {
  constructor(public ambiguous: boolean, status = 502) { super(ambiguous ? 'remote_outcome_unknown' : 'remote_rejected', status); }
}

export function boundedFetch(fetchImpl: typeof fetch, signal?: AbortSignal): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]),
  })) as typeof fetch;
}

export async function jsonResponse<T>(response: Response, mutation = false): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel();
    if (mutation) throw new MutationError(response.status >= 500 || [408, 409, 425].includes(response.status), response.status);
    throw new RouterError(`remote_read_${response.status}`, response.status);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty');
    const parts: Uint8Array[] = []; let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('too_large'); }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    if (mutation) throw new MutationError(true);
    throw new RouterError('invalid_remote_response', 502);
  }
}

export async function mutation<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetchImpl(url, init); } catch { throw new MutationError(true); }
  return jsonResponse<T>(response, true);
}

export async function emptyMutation(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<void> {
  let response: Response;
  try { response = await fetchImpl(url, init); } catch { throw new MutationError(true); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MutationError(response.status >= 500 || [408, 409, 425].includes(response.status), response.status);
  }
  await response.body?.cancel();
}

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength; }
export function boundedText(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  return encoded.length <= bytes ? text : new TextDecoder().decode(encoded.slice(0, Math.max(0, bytes - 40))) + '\n[Context truncated]';
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) throw new RouterError('invalid_remote_identifier', 502);
  return value;
}
