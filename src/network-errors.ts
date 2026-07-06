/**
 * Classify transient network/stream failures that are safe to retry or swallow
 * (a dropped CDN socket, connection reset, timeout). These surface from
 * undici/Baileys when a large media download is interrupted — e.g. when
 * WhatsApp closes the CDN socket mid-transfer on a long voice note. They are
 * not bugs in our code, and must never take the whole bridge down.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const e = err as
    | { code?: string; message?: string; cause?: { code?: string } }
    | undefined;
  const code = e?.code ?? e?.cause?.code ?? '';
  const message = (e?.message ?? '').toLowerCase();
  return (
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE' ||
    message.includes('terminated') ||
    message.includes('other side closed') ||
    message.includes('socket hang up') ||
    message.includes('socket disconnected') ||
    message.includes('network socket')
  );
}
