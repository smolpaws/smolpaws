import { isIP } from 'node:net';
import { constants } from 'node:os';

import { redactTextSecrets } from '@smolpaws/openhands-agent';

export interface ErrorLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export const defaultErrorLogger: ErrorLogger = {
  error(fields, message) {
    console.error(JSON.stringify({ level: 50, time: Date.now(), pid: process.pid, ...fields, msg: message }));
  },
};

interface ErrorDiagnostics {
  code: string;
  detail?: string;
  system_code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
  stack_frames?: string[];
  causes?: ErrorDiagnostics[];
}

const MAX_ERRORS = 8;
const MAX_DEPTH = 4;
const MAX_STACK_FRAMES = 8;
const SYSTEM_CODES = new Set([
  ...Object.keys(constants.errno),
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const SYSCALLS = new Set(['connect', 'read', 'write', 'getaddrinfo', 'lookup', 'open', 'stat', 'rename', 'mkdir', 'unlink']);

function errorCode(error: Error): string {
  try {
    const name = error.constructor.name;
    return /^[A-Za-z_$][\w$]{0,79}$/u.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

function redact(text: string): string {
  return redactTextSecrets(text).replace(/\b(Bearer|Basic)\s+[^\s"',;]+/giu, '$1 <redacted>');
}

/** The event/API summary stays small; diagnostic causes belong only in local logs. */
export function safeRunError(error: unknown): { code: string; detail: string } {
  if (!(error instanceof Error)) return { code: 'Error', detail: 'Conversation run failed.' };
  return { code: errorCode(error), detail: redact(error.message) };
}

function ownValue(error: Error, key: string): unknown {
  try {
    return Object.getOwnPropertyDescriptor(error, key)?.value as unknown;
  } catch {
    return undefined;
  }
}

function stackFrames(error: Error): string[] {
  try {
    const message = ownValue(error, 'message');
    const messageLines = typeof message === 'string' ? message.split('\n').length : 1;
    return (error.stack ?? '').split('\n').slice(messageLines).filter((line) => /^\s+at\s/u.test(line))
      .slice(0, MAX_STACK_FRAMES)
      .map((line) => redact(line).replace(/https?:\/\/[^\s)'"<>]+/giu, '<url>').slice(0, 400));
  } catch {
    return [];
  }
}

/** Never hand an Error to a logger serializer: project a bounded set of diagnostic fields. */
export function safeErrorDiagnostics(error: unknown): ErrorDiagnostics {
  const summary = safeRunError(error);
  if (!(error instanceof Error)) return summary;
  const seen = new Set<Error>();
  let remaining = MAX_ERRORS;
  function project(value: Error, depth: number): ErrorDiagnostics | undefined {
    if (seen.has(value) || depth > MAX_DEPTH || remaining === 0) return undefined;
    seen.add(value);
    remaining -= 1;
    const result: ErrorDiagnostics = { code: errorCode(value) };
    const systemCode = ownValue(value, 'code');
    if (typeof systemCode === 'string' && SYSTEM_CODES.has(systemCode)) result.system_code = systemCode;
    const errno = ownValue(value, 'errno');
    if (typeof errno === 'number' && Number.isSafeInteger(errno) && Math.abs(errno) <= 65535) result.errno = errno;
    const syscall = ownValue(value, 'syscall');
    if (typeof syscall === 'string' && SYSCALLS.has(syscall)) result.syscall = syscall;
    const address = ownValue(value, 'address');
    if (typeof address === 'string' && isIP(address) !== 0) result.address = address;
    const port = ownValue(value, 'port');
    if (typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535) result.port = port;
    const frames = stackFrames(value);
    if (frames.length > 0) result.stack_frames = frames;
    const children: Error[] = [];
    const cause = ownValue(value, 'cause');
    if (cause instanceof Error) children.push(cause);
    if (value instanceof AggregateError) {
      const errors = ownValue(value, 'errors');
      if (Array.isArray(errors)) children.push(...errors.slice(0, MAX_ERRORS).filter((child): child is Error => child instanceof Error));
    }
    const causes = children.flatMap((child) => {
      const projected = project(child, depth + 1);
      return projected === undefined ? [] : [projected];
    });
    if (causes.length > 0) result.causes = causes;
    return result;
  }
  return { ...project(error, 0), ...summary, detail: summary.detail.slice(0, 2000) };
}
