import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { z } from 'zod';

const scenariosSchema = z.object({
  schemaVersion: z.literal(1),
  scenarios: z.array(z.object({
    id: z.string().min(1),
    method: z.literal('GET'),
    path: z.string().startsWith('/'),
    normalization: z.enum(['exact', 'shape']),
  }).strict()),
}).strict();

type FastifyLike = {
  ready?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  inject(options: { method: string; url: string }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    json?: () => unknown;
  }>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolve(import.meta.dirname, '..');
const scenarios = scenariosSchema.parse(JSON.parse(await readFile(resolve(packageRoot, options.cases), 'utf8')));
const persistenceDir = await mkdtemp(resolve(tmpdir(), 'openhands-agent-server-parity-'));
let app: FastifyLike | undefined;

try {
  app = await discoverApp(persistenceDir);
  if (app.ready !== undefined) await app.ready();

  const results: Record<string, unknown> = {};
  for (const scenario of scenarios.scenarios) {
    const response = await app.inject({ method: scenario.method, url: scenario.path });
    const contentTypeHeader = response.headers['content-type'];
    const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader)
      ?.split(';', 1)[0] ?? '';
    results[scenario.id] = {
      status: response.statusCode,
      contentType,
      body: parseBody(response.body, contentType),
    };
  }

  const output = {
    schemaVersion: 1,
    implementation: 'typescript',
    results: canonicalize(results as JsonValue),
  };
  await writeFile(resolve(packageRoot, options.output), `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${options.output} (${scenarios.scenarios.length} server scenarios)`);
} finally {
  if (app?.close !== undefined) await app.close();
  await rm(persistenceDir, { recursive: true, force: true });
}

async function discoverApp(persistenceDir: string): Promise<FastifyLike> {
  const modulePaths = [
    '../src/index.js',
    '../src/app.js',
    '../src/server.js',
    '../src/agent-server.js',
  ];
  const factoryNames = [
    'createApp',
    'buildApp',
    'createServer',
    'buildServer',
    'createAgentServer',
    'createAgentServerApp',
  ];
  const failures: string[] = [];

  for (const modulePath of modulePaths) {
    let module: Record<string, unknown>;
    try {
      module = await import(modulePath) as Record<string, unknown>;
    } catch (error) {
      failures.push(`${modulePath}: import failed: ${errorMessage(error)}`);
      continue;
    }

    for (const value of [module.default, ...factoryNames.map((name) => module[name])]) {
      if (isFastifyLike(value)) return value;
      if (typeof value !== 'function') continue;

      const attempts: unknown[][] = [
        [],
        [{}],
        [{ logger: false }],
        [{
          logger: false,
          persistenceDir,
          persistence_dir: persistenceDir,
          dataDir: persistenceDir,
          baseDir: persistenceDir,
          agentFactory: async () => {
            throw new Error('Agent construction is not needed by basic server scenarios');
          },
        }],
      ];

      for (const args of attempts) {
        try {
          const candidate = await Promise.resolve(value(...args));
          if (isFastifyLike(candidate)) return candidate;
        } catch (error) {
          failures.push(`${modulePath}: factory attempt failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  throw new Error(
    'Could not discover an in-process Fastify app for parity scenarios.\n'
    + failures.slice(0, 20).join('\n'),
  );
}

function isFastifyLike(value: unknown): value is FastifyLike {
  return typeof value === 'object'
    && value !== null
    && 'inject' in value
    && typeof (value as { inject?: unknown }).inject === 'function';
}

function parseBody(body: string, contentType: string): JsonValue {
  if (contentType === 'application/json') {
    return canonicalize(toJsonValue(JSON.parse(body) as unknown));
  }
  return body;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key] as JsonValue);
    return result;
  }
  return value;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry);
    return result;
  }
  throw new Error('Server response body is not JSON-serializable');
}

function isObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(args: readonly string[]): { readonly cases: string; readonly output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith('--')) {
      throw new Error('Usage: --cases <cases.json> --output <target.json>');
    }
    values.set(name.slice(2), value);
  }
  const cases = values.get('cases');
  const output = values.get('output');
  if (cases === undefined || output === undefined) {
    throw new Error('Usage: --cases <cases.json> --output <target.json>');
  }
  return { cases, output };
}
