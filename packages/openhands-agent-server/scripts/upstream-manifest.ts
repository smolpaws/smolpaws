import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const vendoredAgentRoot = resolve(scriptDirectory, '../vendor/openhands-agent');
export const upstreamManifestPath = resolve(vendoredAgentRoot, 'transpile/upstream.json');

export interface VendoredUpstreamManifest {
  readonly schemaVersion: 1;
  readonly repository: 'OpenHands/software-agent-sdk';
  readonly commit: string;
  readonly targets: Readonly<Record<'sdk' | 'server', unknown>>;
  readonly policies: readonly { readonly id: string }[];
}

export function loadUpstreamManifest(): VendoredUpstreamManifest {
  const parsed: unknown = JSON.parse(readFileSync(upstreamManifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${upstreamManifestPath} must contain a JSON object`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) throw new Error('vendored upstream manifest schemaVersion must equal 1');
  if (manifest.repository !== 'OpenHands/software-agent-sdk') {
    throw new Error('vendored upstream manifest repository must be OpenHands/software-agent-sdk');
  }
  if (typeof manifest.commit !== 'string' || !FULL_SHA.test(manifest.commit)) {
    throw new Error('vendored upstream manifest commit must be a full lowercase Git SHA');
  }
  if (typeof manifest.targets !== 'object' || manifest.targets === null || Array.isArray(manifest.targets)) {
    throw new Error('vendored upstream manifest targets must be an object');
  }
  const targets = manifest.targets as Record<string, unknown>;
  if (!('sdk' in targets) || !('server' in targets)) {
    throw new Error('vendored upstream manifest must describe both sdk and server targets');
  }
  if (!Array.isArray(manifest.policies)) throw new Error('vendored upstream manifest policies must be an array');
  const policies = manifest.policies.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`vendored upstream manifest policy ${index} must be an object`);
    }
    const id = (value as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`vendored upstream manifest policy ${index} needs an ID`);
    }
    return { id };
  });
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) {
    throw new Error('vendored upstream manifest policy IDs must be unique');
  }
  return {
    schemaVersion: 1,
    repository: 'OpenHands/software-agent-sdk',
    commit: manifest.commit,
    targets: { sdk: targets.sdk, server: targets.server },
    policies,
  };
}
