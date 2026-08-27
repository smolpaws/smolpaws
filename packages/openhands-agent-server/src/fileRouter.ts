import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AgentServerConfig } from './config.js';
import type { HomeResponse, SubdirectoryPage } from './models.js';
import { param, queryRecord, stringQuery } from './routeUtils.js';

interface UploadRequest extends FastifyRequest {
  file: () => Promise<MultipartFile | undefined>;
}

export function registerFileRoutes(app: FastifyInstance, config: AgentServerConfig): void {
  app.post('/api/file/upload', async (request, reply) => uploadFile(reply, stringQuery(queryRecord(request).path), request, config));
  app.get('/api/file/download', async (request, reply) => downloadFile(reply, stringQuery(queryRecord(request).path), config));
  app.post('/api/file/upload/*', async (request, reply) => uploadFile(reply, normalizeWildcardPath(param(request, '*')), request, config));
  app.get('/api/file/download/*', async (request, reply) => downloadFile(reply, normalizeWildcardPath(param(request, '*')), config));
  app.get('/api/file/home', async (request) => homeResponse(queryRecord(request).include_hidden === 'true'));
  app.get('/api/file/search_subdirs', async (request, reply) => searchSubdirs(reply, request, config));
}

async function uploadFile(reply: ReplyLike, rawPath: string | null, request: FastifyRequest, config: AgentServerConfig): Promise<unknown> {
  const targetPath = await resolveAllowedAbsolutePath(reply, rawPath, config, 'write');
  if (targetPath === null) return undefined;
  const bytes = await uploadBytes(request);
  if (bytes === null) {
    reply.status(400).send({ detail: 'Missing file upload payload' });
    return undefined;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, bytes);
  return { success: true };
}

async function downloadFile(reply: ReplyLike, rawPath: string | null, config: AgentServerConfig): Promise<unknown> {
  const targetPath = await resolveAllowedAbsolutePath(reply, rawPath, config, 'read');
  if (targetPath === null) return undefined;
  const stats = await fs.stat(targetPath).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  });
  if (stats === null) {
    reply.status(404).send({ detail: 'File not found' });
    return undefined;
  }
  if (!stats.isFile()) {
    reply.status(400).send({ detail: 'Path is not a file' });
    return undefined;
  }
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-disposition', contentDispositionHeader(targetPath));
  return createReadStream(targetPath);
}

async function homeResponse(includeHidden: boolean): Promise<HomeResponse> {
  const home = os.homedir();
  return {
    home,
    favorites: await listFavoriteDirs(home, includeHidden),
    locations: process.platform === 'win32' ? [] : [{ label: '/', path: '/' }],
  };
}

async function searchSubdirs(reply: ReplyLike, request: FastifyRequest, config: AgentServerConfig): Promise<SubdirectoryPage | undefined> {
  const query = queryRecord(request);
  const targetPath = await resolveAllowedAbsolutePath(reply, stringQuery(query.path), config, 'read');
  if (targetPath === null) return undefined;
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    reply.status(422).send({ detail: 'limit must be an integer between 1 and 100' });
    return undefined;
  }
  const includeHidden = query.include_hidden === 'true';
  const stats = await fs.stat(targetPath).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  });
  if (stats === null) {
    reply.status(404).send({ detail: 'Directory not found' });
    return undefined;
  }
  if (!stats.isDirectory()) {
    reply.status(400).send({ detail: 'Path is not a directory' });
    return undefined;
  }
  const entries = await subdirectories(targetPath, includeHidden);
  const pageId = stringQuery(query.page_id);
  const start = pageId === null ? 0 : Math.max(0, entries.findIndex((entry) => entry.name.toLowerCase() === pageId));
  const items = entries.slice(start, start + limit);
  const next = entries[start + limit]?.name.toLowerCase() ?? null;
  return { items, next_page_id: next };
}

async function uploadBytes(request: FastifyRequest): Promise<Buffer | null> {
  if (typeof request.isMultipart === 'function' && request.isMultipart()) {
    const part = await (request as UploadRequest).file();
    return part === undefined ? null : part.toBuffer();
  }
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === 'string') return Buffer.from(request.body);
  return null;
}

type FileAccessMode = 'read' | 'write';

async function resolveAllowedAbsolutePath(reply: ReplyLike, rawPath: string | null, config: AgentServerConfig, mode: FileAccessMode): Promise<string | null> {
  const targetPath = validateAbsolutePath(reply, rawPath);
  if (targetPath === null) return null;
  if (!(await isAllowedFilePath(targetPath, config, mode))) {
    reply.status(403).send({ detail: 'Path is outside allowed workspace roots' });
    return null;
  }
  return targetPath;
}

function validateAbsolutePath(reply: ReplyLike, rawPath: string | null): string | null {
  if (rawPath === null || rawPath.trim().length === 0) {
    reply.status(400).send({ detail: 'Path must be absolute' });
    return null;
  }
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed)) {
    reply.status(400).send({ detail: 'Path must be absolute' });
    return null;
  }
  return path.resolve(trimmed);
}

async function isAllowedFilePath(targetPath: string, config: AgentServerConfig, mode: FileAccessMode): Promise<boolean> {
  const roots = config.allowedFileRoots.length > 0 ? config.allowedFileRoots : [config.workspaceRoot];
  const canonicalTarget = mode === 'read' ? await fs.realpath(targetPath).catch(() => path.resolve(targetPath)) : await nearestExistingRealPath(targetPath);
  for (const root of roots) {
    const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root));
    if (isWithinRoot(canonicalTarget, canonicalRoot)) return true;
  }
  return false;
}

async function nearestExistingRealPath(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  while (true) {
    const real = await fs.realpath(current).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    });
    if (real !== null) return real;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function normalizeWildcardPath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function contentDispositionHeader(targetPath: string): string {
  const filename = path.basename(targetPath);
  const fallback = sanitizeQuotedFilename(filename) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeQuotedFilename(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || character === '"' || character === '\\' ? '_' : character;
  }).join('');
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function listFavoriteDirs(home: string, includeHidden: boolean): Promise<Array<{ readonly label: string; readonly path: string }>> {
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && (includeHidden || !entry.name.startsWith('.')))
    .slice(0, 20)
    .map((entry) => ({ label: entry.name, path: path.join(home, entry.name) }));
}

async function subdirectories(targetPath: string, includeHidden: boolean): Promise<Array<{ readonly name: string; readonly path: string }>> {
  const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isErrno(error, 'EACCES')) return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && (includeHidden || !entry.name.startsWith('.')))
    .map((entry) => ({ name: entry.name, path: path.join(targetPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function isErrno(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}


interface ReplyLike {
  status: (code: number) => ReplyLike;
  send: (payload: unknown) => void;
  header: (name: string, value: string) => ReplyLike;
}
