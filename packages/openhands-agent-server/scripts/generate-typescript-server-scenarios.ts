import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { z } from 'zod';

import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { createAgentServerApp } from '../src/app.js';

const scenariosSchema = z.object({
  schemaVersion: z.literal(1),
  scenarios: z.array(z.object({
    id: z.string().min(1),
    method: z.literal('GET'),
    path: z.string().startsWith('/'),
    normalization: z.enum(['exact', 'shape']),
  }).strict()),
}).strict();

type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolve(import.meta.dirname, '..');
const scenarios = scenariosSchema.parse(JSON.parse(await readFile(resolve(packageRoot, options.cases), 'utf8')));
const root = await mkdtemp(resolve(tmpdir(), 'openhands-agent-server-parity-'));
const server = await createAgentServerApp({
  agentFactory: () => {
    throw new Error('Agent construction is not needed by basic server scenarios');
  },
  secretStore: new InMemorySecretStore(),
  logger: false,
  config: {
    conversationsPath: resolve(root, 'conversations'),
    bashEventsPath: resolve(root, 'bash-events'),
    statePath: resolve(root, 'state'),
    workspaceRoot: resolve(root, 'workspace'),
    allowedFileRoots: [resolve(root, 'workspace')],
  },
});

try {
  await server.app.ready();

  const results: Record<string, unknown> = {};
  for (const scenario of scenarios.scenarios) {
    const response = await server.app.inject({ method: scenario.method, url: scenario.path });
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
  await server.app.close();
  await rm(root, { recursive: true, force: true });
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
