import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadUpstreamManifest, vendoredAgentRoot } from './upstream-manifest.js';

const manifest = loadUpstreamManifest();
const packagePath = resolve(vendoredAgentRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  readonly name?: unknown;
  readonly files?: unknown;
  readonly _smolpawsProvenance?: Readonly<Record<string, unknown>>;
};

if (packageJson.name !== '@smolpaws/openhands-agent') {
  throw new Error(`${packagePath} is not the expected vendored SDK package`);
}
if (!Array.isArray(packageJson.files) || !packageJson.files.includes('transpile')) {
  throw new Error('vendored SDK package.json must publish the transpile directory');
}
if (packageJson._smolpawsProvenance?.upstreamOpenHandsCommit !== undefined) {
  throw new Error('remove duplicate _smolpawsProvenance.upstreamOpenHandsCommit; transpile/upstream.json is canonical');
}

console.log(`Vendored SDK provenance is valid: ${manifest.repository}@${manifest.commit}`);
