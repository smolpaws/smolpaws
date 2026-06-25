import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCoalesceWindowMs, DEFAULT_COALESCE_WINDOW_MS } from './bridgeCoalesceConfig.js';

test('explicit numeric config wins over env and default', () => {
  assert.equal(resolveCoalesceWindowMs(500, { BRIDGE_COALESCE_WINDOW_MS: '9999' }), 500);
});

test('explicit 0 disables coalescing (and beats env)', () => {
  assert.equal(resolveCoalesceWindowMs(0, { BRIDGE_COALESCE_WINDOW_MS: '9999' }), 0);
});

test('negative explicit is clamped to 0', () => {
  assert.equal(resolveCoalesceWindowMs(-100, {}), 0);
});

test('env is used when no explicit value', () => {
  assert.equal(resolveCoalesceWindowMs(undefined, { BRIDGE_COALESCE_WINDOW_MS: '2000' }), 2000);
});

test('negative env is clamped to 0', () => {
  assert.equal(resolveCoalesceWindowMs(undefined, { BRIDGE_COALESCE_WINDOW_MS: '-5' }), 0);
});

test('falls back to default when nothing configured', () => {
  assert.equal(resolveCoalesceWindowMs(undefined, {}), DEFAULT_COALESCE_WINDOW_MS);
});

test('non-numeric env falls back to default', () => {
  assert.equal(resolveCoalesceWindowMs(undefined, { BRIDGE_COALESCE_WINDOW_MS: 'nope' }), DEFAULT_COALESCE_WINDOW_MS);
});

test('blank env falls back to default', () => {
  assert.equal(resolveCoalesceWindowMs(undefined, { BRIDGE_COALESCE_WINDOW_MS: '   ' }), DEFAULT_COALESCE_WINDOW_MS);
});

test('non-finite explicit (NaN) falls through to env/default', () => {
  assert.equal(resolveCoalesceWindowMs(Number.NaN, { BRIDGE_COALESCE_WINDOW_MS: '300' }), 300);
});
