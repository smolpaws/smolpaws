import { readFile, writeFile } from 'node:fs/promises';
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

const resultSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  body: z.unknown(),
}).strict();

const pythonSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    repository: z.literal('OpenHands/software-agent-sdk'),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
  }).strict(),
  results: z.record(z.string(), resultSchema),
}).strict();

const targetSchema = z.object({
  schemaVersion: z.literal(1),
  implementation: z.literal('typescript'),
  results: z.record(z.string(), resultSchema),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal('OpenHands/software-agent-sdk'),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
}).passthrough();

type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

type Difference = {
  readonly path: string;
  readonly python?: string;
  readonly typescript?: string;
};

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolve(import.meta.dirname, '..');
const manifest = manifestSchema.parse(await readJson(
  resolve(packageRoot, 'vendor/openhands-agent/transpile/upstream.json'),
));
const scenarios = scenariosSchema.parse(await readJson(
  resolve(packageRoot, 'transpile/server-scenarios/basic.json'),
));
const python = pythonSchema.parse(await readJson(
  resolve(packageRoot, 'transpile/server-scenarios/python-basic.json'),
));
const target = targetSchema.parse(await readJson(
  resolve(packageRoot, 'transpile/server-scenarios/typescript-basic.json'),
));

if (python.source.commit !== manifest.commit) {
  throw new Error(
    `Python server scenarios are pinned to ${python.source.commit}, but the vendored manifest is ${manifest.commit}`,
  );
}

const mismatches: Record<string, {
  readonly normalization: 'exact' | 'shape';
  readonly differences: readonly Difference[];
}> = {};

for (const scenario of scenarios.scenarios) {
  const pythonResult = python.results[scenario.id];
  const targetResult = target.results[scenario.id];
  if (pythonResult === undefined || targetResult === undefined) {
    throw new Error(`Missing generated scenario result: ${scenario.id}`);
  }

  const pythonComparable = normalizeResult(pythonResult, scenario.normalization);
  const targetComparable = normalizeResult(targetResult, scenario.normalization);
  const differences: Difference[] = [];
  diffValue(pythonComparable, targetComparable, '', differences);
  if (differences.length > 0) {
    mismatches[scenario.id] = {
      normalization: scenario.normalization,
      differences,
    };
  }
}

const expectedIds = new Set(scenarios.scenarios.map((scenario) => scenario.id));
for (const id of [...Object.keys(python.results), ...Object.keys(target.results)]) {
  if (!expectedIds.has(id)) throw new Error(`Generated scenario result is stale: ${id}`);
}

const report = {
  schemaVersion: 1,
  sourceCommit: manifest.commit,
  scenarioCount: scenarios.scenarios.length,
  mismatchCount: Object.keys(mismatches).length,
  mismatches,
};
const outputPath = resolve(packageRoot, options.output);
const rendered = `${JSON.stringify(report, null, 2)}\n`;

if (options.check) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== rendered) {
    console.error('Basic server scenario report is stale.');
    process.exit(1);
  }
  console.log(
    `Basic server scenario report is current: ${report.mismatchCount} of ${report.scenarioCount} scenarios differ.`,
  );
} else {
  await writeFile(outputPath, rendered);
  console.log(
    `Wrote ${outputPath}: ${report.mismatchCount} of ${report.scenarioCount} scenarios differ.`,
  );
}

function normalizeResult(
  result: z.infer<typeof resultSchema>,
  normalization: 'exact' | 'shape',
): JsonValue {
  const body = toJsonValue(result.body);
  return {
    status: result.status,
    contentType: result.contentType,
    body: normalization === 'exact' ? canonicalize(body) : shape(body),
  };
}

function shape(value: JsonValue): JsonValue {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: [...new Set(value.map((entry) => JSON.stringify(shape(entry))))]
        .sort()
        .map((entry) => JSON.parse(entry) as JsonValue),
    };
  }
  if (isObject(value)) {
    const properties: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) properties[key] = shape(value[key] as JsonValue);
    return { type: 'object', properties };
  }
  return typeof value;
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

function diffValue(
  pythonValue: JsonValue | undefined,
  typescriptValue: JsonValue | undefined,
  path: string,
  differences: Difference[],
): void {
  if (pythonValue === undefined && typescriptValue === undefined) return;
  if (pythonValue === undefined || typescriptValue === undefined) {
    differences.push({
      path: displayPath(path),
      ...(pythonValue === undefined ? {} : { python: render(pythonValue) }),
      ...(typescriptValue === undefined ? {} : { typescript: render(typescriptValue) }),
    });
    return;
  }
  if (Object.is(pythonValue, typescriptValue)) return;

  if (Array.isArray(pythonValue) || Array.isArray(typescriptValue)) {
    if (!Array.isArray(pythonValue) || !Array.isArray(typescriptValue)) {
      differences.push({
        path: displayPath(path),
        python: render(pythonValue),
        typescript: render(typescriptValue),
      });
      return;
    }
    const length = Math.max(pythonValue.length, typescriptValue.length);
    for (let index = 0; index < length; index += 1) {
      diffValue(pythonValue[index], typescriptValue[index], `${path}/${index}`, differences);
    }
    return;
  }

  if (isObject(pythonValue) || isObject(typescriptValue)) {
    if (!isObject(pythonValue) || !isObject(typescriptValue)) {
      differences.push({
        path: displayPath(path),
        python: render(pythonValue),
        typescript: render(typescriptValue),
      });
      return;
    }
    const keys = new Set([...Object.keys(pythonValue), ...Object.keys(typescriptValue)]);
    for (const key of [...keys].sort()) {
      diffValue(
        pythonValue[key],
        typescriptValue[key],
        `${path}/${escapePointer(key)}`,
        differences,
      );
    }
    return;
  }

  differences.push({
    path: displayPath(path),
    python: render(pythonValue),
    typescript: render(typescriptValue),
  });
}

function render(value: JsonValue): string {
  const rendered = JSON.stringify(value);
  return rendered.length <= 400 ? rendered : `${rendered.slice(0, 400)}…`;
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
  throw new Error('Scenario result is not JSON-serializable');
}

function isObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayPath(path: string): string {
  return path.length === 0 ? '/' : path;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function parseArgs(args: readonly string[]): { readonly output: string; readonly check: boolean } {
  let output = 'transpile/server-scenarios/basic-report.json';
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--output') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--output requires a path');
      output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? '<missing>'}`);
  }
  return { output, check };
}
