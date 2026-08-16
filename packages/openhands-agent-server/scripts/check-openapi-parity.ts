import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const httpMethods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
]);

type OperationKey = `${Uppercase<string>} ${string}`;

const manifestSchema = z.object({
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  policies: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['DEVIATION', 'EXCLUDED', 'EXTENSION']),
    target: z.enum(['sdk', 'server']),
  })),
});

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  generator: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  compatibilityShim: z.string().min(1).optional(),
});

const deferredOperationSchema = z.object({
  disposition: z.literal('DEFERRED'),
  tracking: z.string().min(1),
  reason: z.string().min(1),
});

const deviationOperationSchema = z.object({
  disposition: z.literal('DEVIATION'),
  policy: z.string().regex(/^DEV-/),
  reason: z.string().min(1),
});

const excludedOperationSchema = z.object({
  disposition: z.literal('EXCLUDED'),
  policy: z.string().regex(/^EXC-/),
  reason: z.string().min(1),
});

const missingOperationSchema = z.discriminatedUnion('disposition', [
  deferredOperationSchema,
  deviationOperationSchema,
  excludedOperationSchema,
]);

const policySchema = z.object({
  schemaVersion: z.literal(1),
  tracking: z.record(z.string(), z.object({
    path: z.string().min(1),
    description: z.string().min(1),
  })),
  missingOperations: z.record(z.string(), missingOperationSchema),
  extensions: z.record(z.string(), z.object({
    policy: z.string().regex(/^EXT-/),
    reason: z.string().min(1),
  })),
});

const openApiSchema = z.object({
  openapi: z.string().min(1),
  paths: z.record(z.string(), z.unknown()),
}).passthrough();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(
  packageRoot,
  'vendor/openhands-agent/transpile/upstream.json',
);
const pythonOpenApiPath = resolve(packageRoot, 'transpile/python-openapi.json');
const metadataPath = resolve(packageRoot, 'transpile/python-openapi.meta.json');
const targetOpenApiPath = resolve(packageRoot, 'openapi.json');
const policyPath = resolve(packageRoot, 'transpile/openapi-policy.json');

const manifest = manifestSchema.parse(await readJson(manifestPath));
const metadata = metadataSchema.parse(await readJson(metadataPath));
const policy = policySchema.parse(await readJson(policyPath));
const pythonBytes = await readFile(pythonOpenApiPath);
const pythonOpenApi = openApiSchema.parse(JSON.parse(pythonBytes.toString('utf8')));
const targetOpenApi = openApiSchema.parse(await readJson(targetOpenApiPath));

const problems: string[] = [];

if (metadata.repository !== manifest.repository) {
  problems.push(
    `Python OpenAPI repository ${metadata.repository} does not match canonical manifest ${manifest.repository}.`,
  );
}
if (metadata.commit !== manifest.commit) {
  problems.push(
    `Python OpenAPI commit ${metadata.commit} does not match canonical manifest ${manifest.commit}.`,
  );
}

const actualSha256 = createHash('sha256').update(pythonBytes).digest('hex');
if (actualSha256 !== metadata.sha256) {
  problems.push(
    `Python OpenAPI sha256 mismatch: metadata=${metadata.sha256}, actual=${actualSha256}.`,
  );
}

const knownPolicies = new Map(
  manifest.policies.map((entry) => [entry.id, entry] as const),
);

for (const [trackingId, tracking] of Object.entries(policy.tracking)) {
  const trackingPath = resolve(packageRoot, tracking.path);
  const rootPrefix = `${packageRoot}${sep}`;
  if (trackingPath !== packageRoot && !trackingPath.startsWith(rootPrefix)) {
    problems.push(`Tracking ${trackingId} escapes the package root: ${tracking.path}.`);
    continue;
  }

  try {
    await access(trackingPath);
  } catch {
    problems.push(`Tracking ${trackingId} points to a missing path: ${tracking.path}.`);
  }
}

for (const [operation, entry] of Object.entries(policy.missingOperations)) {
  if (entry.disposition === 'DEFERRED') {
    if (policy.tracking[entry.tracking] === undefined) {
      problems.push(
        `${operation} references unknown tracking item ${entry.tracking}.`,
      );
    }
    continue;
  }

  const known = knownPolicies.get(entry.policy);
  if (known === undefined) {
    problems.push(`${operation} references unknown policy ${entry.policy}.`);
    continue;
  }
  if (known.target !== 'server') {
    problems.push(`${operation} references non-server policy ${entry.policy}.`);
  }
  if (known.kind !== entry.disposition) {
    problems.push(
      `${operation} disposition ${entry.disposition} does not match ${entry.policy} kind ${known.kind}.`,
    );
  }
}

for (const [operation, entry] of Object.entries(policy.extensions)) {
  const known = knownPolicies.get(entry.policy);
  if (known === undefined) {
    problems.push(`${operation} references unknown extension policy ${entry.policy}.`);
    continue;
  }
  if (known.target !== 'server' || known.kind !== 'EXTENSION') {
    problems.push(
      `${operation} references ${entry.policy}, which is not a server EXTENSION policy.`,
    );
  }
}

const pythonOperations = extractOperations(pythonOpenApi.paths);
const targetOperations = extractOperations(targetOpenApi.paths);
const pythonOnly = difference(pythonOperations, targetOperations);
const targetOnly = difference(targetOperations, pythonOperations);

const missingPolicyKeys = new Set(
  Object.keys(policy.missingOperations) as OperationKey[],
);
const extensionPolicyKeys = new Set(Object.keys(policy.extensions) as OperationKey[]);

const unclassifiedMissing = [...pythonOnly]
  .filter((operation) => !missingPolicyKeys.has(operation))
  .sort();
const staleMissingPolicies = [...missingPolicyKeys]
  .filter((operation) => !pythonOnly.has(operation))
  .sort();
const unclassifiedExtensions = [...targetOnly]
  .filter((operation) => !extensionPolicyKeys.has(operation))
  .sort();
const staleExtensionPolicies = [...extensionPolicyKeys]
  .filter((operation) => !targetOnly.has(operation))
  .sort();

appendList(
  problems,
  'Missing upstream operations without an explicit disposition:',
  unclassifiedMissing,
);
appendList(
  problems,
  'Missing-operation policies that are stale or now implemented:',
  staleMissingPolicies,
);
appendList(
  problems,
  'Target-only operations without an EXT-* policy:',
  unclassifiedExtensions,
);
appendList(
  problems,
  'Extension policies that are stale or no longer target-only:',
  staleExtensionPolicies,
);

if (problems.length > 0) {
  console.error(
    `OpenAPI operation parity failed against ${manifest.repository}@${manifest.commit}.`,
  );
  for (const problem of problems) {
    console.error(`\n${problem}`);
  }
  process.exit(1);
}

const sharedCount = [...pythonOperations]
  .filter((operation) => targetOperations.has(operation))
  .length;
const deferredCount = Object.values(policy.missingOperations)
  .filter((entry) => entry.disposition === 'DEFERRED')
  .length;
const permanentDifferenceCount = Object.values(policy.missingOperations)
  .filter((entry) => entry.disposition !== 'DEFERRED')
  .length;

console.log(
  `OpenAPI operation parity passed against ${manifest.repository}@${manifest.commit}: `
  + `${pythonOperations.size} upstream operations (`
  + `${sharedCount} shared, ${deferredCount} deferred, `
  + `${permanentDifferenceCount} permanent differences); `
  + `${targetOnly.size} explicit target extensions.`,
);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function extractOperations(paths: Record<string, unknown>): ReadonlySet<OperationKey> {
  const operations = new Set<OperationKey>();

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      throw new Error(`OpenAPI path item is not an object: ${rawPath}`);
    }

    const path = normalizePath(rawPath);
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!httpMethods.has(normalizedMethod)) continue;
      if (!isObject(operation)) {
        throw new Error(`OpenAPI operation is not an object: ${method.toUpperCase()} ${path}`);
      }
      operations.add(`${normalizedMethod.toUpperCase()} ${path}` as OperationKey);
    }
  }

  return operations;
}

function normalizePath(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/u, '');
}

function difference(
  left: ReadonlySet<OperationKey>,
  right: ReadonlySet<OperationKey>,
): ReadonlySet<OperationKey> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function appendList(
  problems: string[],
  heading: string,
  values: readonly string[],
): void {
  if (values.length === 0) return;
  problems.push(`${heading}\n${values.map((value) => `  - ${value}`).join('\n')}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
