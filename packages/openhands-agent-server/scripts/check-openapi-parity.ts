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
type JsonObject = Record<string, unknown>;

interface OperationEntry {
  readonly operation: JsonObject;
  readonly pathParameters: readonly unknown[];
}

interface ParameterContract {
  readonly required: boolean;
}

interface RequestBodyContract {
  readonly required: boolean;
  readonly mediaTypes: ReadonlySet<string>;
}

type ResponseContract = ReadonlyMap<string, ReadonlySet<string>>;

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

const contractExemptionSchema = z.object({
  policy: z.string().regex(/^DEV-/),
  reason: z.string().min(1),
});

const policySchema = z.object({
  schemaVersion: z.literal(1),
  tracking: z.record(z.string(), z.object({
    path: z.string().min(1),
    description: z.string().min(1),
  })),
  missingOperations: z.record(z.string(), missingOperationSchema),
  contractExemptions: z.record(z.string(), contractExemptionSchema),
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

  validatePolicyReference(operation, entry.policy, entry.disposition);
}

for (const [operation, entry] of Object.entries(policy.contractExemptions)) {
  validatePolicyReference(operation, entry.policy, 'DEVIATION');
}

for (const [operation, entry] of Object.entries(policy.extensions)) {
  validatePolicyReference(operation, entry.policy, 'EXTENSION');
}

const pythonOperationMap = extractOperationMap(pythonOpenApi.paths);
const targetOperationMap = extractOperationMap(targetOpenApi.paths);
const pythonOperations = new Set(pythonOperationMap.keys());
const targetOperations = new Set(targetOperationMap.keys());
const pythonOnly = difference(pythonOperations, targetOperations);
const targetOnly = difference(targetOperations, pythonOperations);

const missingPolicyKeys = new Set(
  Object.keys(policy.missingOperations) as OperationKey[],
);
const contractExemptionKeys = new Set(
  Object.keys(policy.contractExemptions) as OperationKey[],
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
const staleContractExemptions = [...contractExemptionKeys]
  .filter(
    (operation) => !pythonOperations.has(operation) || !targetOperations.has(operation),
  )
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
appendList(
  problems,
  'Contract exemptions that no longer refer to shared operations:',
  staleContractExemptions,
);

const sharedOperations = [...pythonOperations]
  .filter((operation) => targetOperations.has(operation))
  .sort();

for (const operationKey of sharedOperations) {
  if (contractExemptionKeys.has(operationKey)) continue;

  const pythonEntry = pythonOperationMap.get(operationKey);
  const targetEntry = targetOperationMap.get(operationKey);
  if (pythonEntry === undefined || targetEntry === undefined) {
    throw new Error(`Internal operation-map mismatch for ${operationKey}`);
  }

  compareOperationContract(operationKey, pythonEntry, targetEntry, problems);
}

if (problems.length > 0) {
  console.error(
    `OpenAPI parity failed against ${manifest.repository}@${manifest.commit}.`,
  );
  for (const problem of problems) {
    console.error(`\n${problem}`);
  }
  process.exit(1);
}

const deferredCount = Object.values(policy.missingOperations)
  .filter((entry) => entry.disposition === 'DEFERRED')
  .length;
const permanentDifferenceCount = Object.values(policy.missingOperations)
  .filter((entry) => entry.disposition !== 'DEFERRED')
  .length;

console.log(
  `OpenAPI parity passed against ${manifest.repository}@${manifest.commit}: `
  + `${pythonOperations.size} upstream operations (`
  + `${sharedOperations.length} shared, ${deferredCount} deferred, `
  + `${permanentDifferenceCount} permanent differences); `
  + `${targetOnly.size} explicit target extensions; `
  + `${contractExemptionKeys.size} shared contract exemptions.`,
);

function validatePolicyReference(
  operation: string,
  policyId: string,
  expectedKind: 'DEVIATION' | 'EXCLUDED' | 'EXTENSION',
): void {
  const known = knownPolicies.get(policyId);
  if (known === undefined) {
    problems.push(`${operation} references unknown policy ${policyId}.`);
    return;
  }
  if (known.target !== 'server') {
    problems.push(`${operation} references non-server policy ${policyId}.`);
  }
  if (known.kind !== expectedKind) {
    problems.push(
      `${operation} expects ${expectedKind}, but ${policyId} has kind ${known.kind}.`,
    );
  }
}

function compareOperationContract(
  operationKey: OperationKey,
  pythonEntry: OperationEntry,
  targetEntry: OperationEntry,
  output: string[],
): void {
  const pythonParameters = parameterContracts(operationKey, pythonEntry, 'upstream', output);
  const targetParameters = parameterContracts(operationKey, targetEntry, 'target', output);

  for (const [parameterKey, pythonParameter] of pythonParameters) {
    const targetParameter = targetParameters.get(parameterKey);
    if (targetParameter === undefined) {
      output.push(`${operationKey} is missing upstream parameter ${parameterKey}.`);
      continue;
    }
    if (targetParameter.required !== pythonParameter.required) {
      output.push(
        `${operationKey} parameter ${parameterKey} requiredness differs: `
        + `upstream=${pythonParameter.required}, target=${targetParameter.required}.`,
      );
    }
  }

  const pythonRequest = requestBodyContract(operationKey, pythonEntry.operation, 'upstream', output);
  const targetRequest = requestBodyContract(operationKey, targetEntry.operation, 'target', output);

  if (pythonRequest !== null) {
    if (targetRequest === null) {
      output.push(`${operationKey} is missing an upstream request body.`);
    } else {
      if (targetRequest.required !== pythonRequest.required) {
        output.push(
          `${operationKey} request-body requiredness differs: `
          + `upstream=${pythonRequest.required}, target=${targetRequest.required}.`,
        );
      }
      appendMissingMediaTypes(
        output,
        operationKey,
        'request body',
        pythonRequest.mediaTypes,
        targetRequest.mediaTypes,
      );
    }
  }

  const pythonResponses = responseContracts(operationKey, pythonEntry.operation, 'upstream', output);
  const targetResponses = responseContracts(operationKey, targetEntry.operation, 'target', output);

  for (const [status, pythonMediaTypes] of pythonResponses) {
    const targetMediaTypes = targetResponses.get(status);
    if (targetMediaTypes === undefined) {
      output.push(`${operationKey} is missing upstream response status ${status}.`);
      continue;
    }
    appendMissingMediaTypes(
      output,
      operationKey,
      `response ${status}`,
      pythonMediaTypes,
      targetMediaTypes,
    );
  }
}

function parameterContracts(
  operationKey: OperationKey,
  entry: OperationEntry,
  side: 'upstream' | 'target',
  output: string[],
): ReadonlyMap<string, ParameterContract> {
  const contracts = new Map<string, ParameterContract>();
  const operationParameters = arrayValue(entry.operation.parameters);

  for (const rawParameter of [...entry.pathParameters, ...operationParameters]) {
    if (!isObject(rawParameter)) {
      output.push(`${operationKey} has a non-object ${side} parameter.`);
      continue;
    }
    if ('$ref' in rawParameter) {
      output.push(
        `${operationKey} uses an unresolved ${side} parameter reference ${String(rawParameter.$ref)}.`,
      );
      continue;
    }

    const name = rawParameter.name;
    const location = rawParameter.in;
    if (typeof name !== 'string' || typeof location !== 'string') {
      output.push(`${operationKey} has a ${side} parameter without string name/in fields.`);
      continue;
    }

    contracts.set(`${location}:${name}`, {
      required: rawParameter.required === true,
    });
  }

  return contracts;
}

function requestBodyContract(
  operationKey: OperationKey,
  operation: JsonObject,
  side: 'upstream' | 'target',
  output: string[],
): RequestBodyContract | null {
  const requestBody = operation.requestBody;
  if (requestBody === undefined) return null;
  if (!isObject(requestBody)) {
    output.push(`${operationKey} has a non-object ${side} request body.`);
    return null;
  }
  if ('$ref' in requestBody) {
    output.push(
      `${operationKey} uses an unresolved ${side} request-body reference ${String(requestBody.$ref)}.`,
    );
    return null;
  }

  return {
    required: requestBody.required === true,
    mediaTypes: contentMediaTypes(requestBody.content),
  };
}

function responseContracts(
  operationKey: OperationKey,
  operation: JsonObject,
  side: 'upstream' | 'target',
  output: string[],
): ResponseContract {
  const responses = operation.responses;
  if (!isObject(responses)) {
    output.push(`${operationKey} has no object-valued ${side} responses map.`);
    return new Map();
  }

  const contracts = new Map<string, ReadonlySet<string>>();
  for (const [status, rawResponse] of Object.entries(responses)) {
    // FastAPI adds the same framework-generated validation response to most
    // parameterized operations. Runtime validation parity is tested separately;
    // keeping it out here avoids one noisy exception per route.
    if (status === '422') continue;

    if (!isObject(rawResponse)) {
      output.push(`${operationKey} response ${status} is not an object on ${side}.`);
      continue;
    }
    if ('$ref' in rawResponse) {
      output.push(
        `${operationKey} uses an unresolved ${side} response reference ${String(rawResponse.$ref)} for ${status}.`,
      );
      continue;
    }
    contracts.set(status, contentMediaTypes(rawResponse.content));
  }

  return contracts;
}

function contentMediaTypes(content: unknown): ReadonlySet<string> {
  if (!isObject(content)) return new Set();
  return new Set(Object.keys(content).sort());
}

function appendMissingMediaTypes(
  output: string[],
  operationKey: OperationKey,
  area: string,
  upstream: ReadonlySet<string>,
  target: ReadonlySet<string>,
): void {
  const missing = [...upstream].filter((mediaType) => !target.has(mediaType)).sort();
  if (missing.length === 0) return;
  output.push(
    `${operationKey} ${area} is missing upstream media type(s): ${missing.join(', ')}.`,
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function extractOperationMap(
  paths: Record<string, unknown>,
): ReadonlyMap<OperationKey, OperationEntry> {
  const operations = new Map<OperationKey, OperationEntry>();

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      throw new Error(`OpenAPI path item is not an object: ${rawPath}`);
    }

    const path = normalizePath(rawPath);
    const pathParameters = arrayValue(pathItem.parameters);
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!httpMethods.has(normalizedMethod)) continue;
      if (!isObject(operation)) {
        throw new Error(`OpenAPI operation is not an object: ${method.toUpperCase()} ${path}`);
      }

      const key = `${normalizedMethod.toUpperCase()} ${path}` as OperationKey;
      if (operations.has(key)) {
        throw new Error(`Duplicate normalized OpenAPI operation: ${key}`);
      }
      operations.set(key, { operation, pathParameters });
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
  output: string[],
  heading: string,
  values: readonly string[],
): void {
  if (values.length === 0) return;
  output.push(`${heading}\n${values.map((value) => `  - ${value}`).join('\n')}`);
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
