import { expect, it } from 'vitest';
import { publicStartConversationRequestSchema, serverInfoSchema } from '../models.js';

it('normalizes missing/null observability fields without trimming body values', () => {
  const defaults = { user_id: null, observability_metadata: {}, observability_tags: [], observability_span_name: 'conversation', observability_parent_span_context: null };
  expect(publicStartConversationRequestSchema.parse({})).toMatchObject(defaults);
  expect(publicStartConversationRequestSchema.parse(Object.fromEntries(Object.keys(defaults).map(key => [key, null])))).toMatchObject(defaults);
  expect(publicStartConversationRequestSchema.parse({ user_id: '', observability_tags: [' '], observability_parent_span_context: '' })).toMatchObject({ user_id: '', observability_tags: [' '], observability_parent_span_context: '' });
});

it('validates scalar/homogeneous metadata, finite JS numbers, tags and bounded ASCII span names', () => {
  const metadata = { s: '', n: 1, b: false, empty: [], ss: ['a', 'b'], ns: [1, 1.5], bs: [true, false] };
  expect(publicStartConversationRequestSchema.parse({ observability_metadata: metadata, observability_span_name: 'job/run-1:v2.ok' }).observability_metadata).toEqual(metadata);
  for (const value of [{ x: null }, { x: {} }, { x: [1, true] }, { x: ['a', 1] }, { x: Infinity }, { x: [NaN] }, { '': 1 }, []]) {
    expect(() => publicStartConversationRequestSchema.parse({ observability_metadata: value })).toThrow();
  }
  for (const value of ['', 'x'.repeat(129), 'name space', 'é', 'x\n']) expect(() => publicStartConversationRequestSchema.parse({ observability_span_name: value })).toThrow();
  for (const value of [[''], [1], 'tag']) expect(() => publicStartConversationRequestSchema.parse({ observability_tags: value })).toThrow();
});

it('defaults old server-info payloads to a local runtime with no advertised capabilities', () => {
  expect(serverInfoSchema.parse({ uptime: 0, version: 'fixture', node_version: 'fixture' })).toMatchObject({ capabilities: [], conversation_runtime: 'local', app_backend_ingress_url: null });
});
