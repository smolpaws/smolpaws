import assert from 'node:assert/strict';
import test from 'node:test';

import { TRIGGER_PATTERN } from './config.js';

test('trigger matches assistant mentions inside a sentence', () => {
  assert.equal(TRIGGER_PATTERN.test('@smolpaws hello'), true);
  assert.equal(TRIGGER_PATTERN.test('Ami, this is smolpaws. @smolpaws say hi'), true);
  assert.equal(TRIGGER_PATTERN.test('hello (@smolpaws)'), true);
});

test('trigger ignores plain name references without an at-mention', () => {
  assert.equal(TRIGGER_PATTERN.test('smolpaws is listening quietly'), false);
  assert.equal(TRIGGER_PATTERN.test('email me at ami@smolpaws.test'), false);
});
