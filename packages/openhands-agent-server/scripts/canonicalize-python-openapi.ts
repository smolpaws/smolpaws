import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type Options = {
  input: string;
  output: string;
  metadata: string;
  repository: string;
  commit: string;
  generator: string;
};

const options = parseArgs(process.argv.slice(2));
const parsed = JSON.parse(await readFile(resolve(options.input), 'utf8')) as JsonValue;
assertOpenApiDocument(parsed);

const canonical = canonicalize(parsed);
const serialized = `${JSON.stringify(canonical, null, 2)}\n`;
const sha256 = createHash('sha256').update(serialized).digest('hex');

const metadata = canonicalize({
  schemaVersion: 1,
  repository: options.repository,
  commit: options.commit,
  generator: options.generator,
  sha256,
});

await mkdir(dirname(resolve(options.output)), { recursive: true });
await mkdir(dirname(resolve(options.metadata)), { recursive: true });
await writeFile(resolve(options.output), serialized);
await writeFile(resolve(options.metadata), `${JSON.stringify(metadata, null, 2)}\n`);

console.log(`Wrote ${options.output}`);
console.log(`Wrote ${options.metadata}`);

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error(`Expected --name value pairs; received: ${args.join(' ')}`);
    }
    values.set(key.slice(2), value);
  }

  return {
    input: required(values, 'input'),
    output: required(values, 'output'),
    metadata: required(values, 'metadata'),
    repository: required(values, 'repository'),
    commit: required(values, 'commit'),
    generator: required(values, 'generator'),
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function assertOpenApiDocument(value: JsonValue): asserts value is { [key: string]: JsonValue } {
  if (!isObject(value)) {
    throw new Error('Python generator did not produce a JSON object');
  }
  if (typeof value.openapi !== 'string') {
    throw new Error('Python generator output is missing an OpenAPI version');
  }
  if (!isObject(value.paths)) {
    throw new Error('Python generator output is missing a paths object');
  }
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
