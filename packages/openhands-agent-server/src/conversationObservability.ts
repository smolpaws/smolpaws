import { z } from 'zod';
import {
  observabilityMetadataSchema, observabilitySpanNameSchema, observabilityTagsSchema,
  publicStartConversationRequestSchema, type StartConversationRequest,
} from './models.js';

/** Preserve body field presence before schema defaults; trace data grants no authority. */
export function mergeConversationObservability(
  input: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): StartConversationRequest {
  const body = publicStartConversationRequestSchema.parse(input);
  const owns = (name: string) => typeof input === 'object' && input !== null && Object.hasOwn(input, name);
  const header = (name: string) => {
    const value = headers[`x-openhands-observability-${name}`];
    return typeof value === 'string' ? value : '';
  };
  const span = header('span-name');
  const tags = header('tags');
  const metadata = header('metadata');
  const parent = header('parent-span-context');
  if (span && !owns('observability_span_name')) body.observability_span_name = observabilitySpanNameSchema.parse(span);
  if (tags && !owns('observability_tags')) {
    body.observability_tags = observabilityTagsSchema.parse(tags.split(',').map(value => value.trim()).filter(Boolean));
  }
  if (metadata) {
    let parsed;
    try {
      parsed = observabilityMetadataSchema.parse(JSON.parse(metadata));
    } catch {
      throw new z.ZodError([{ code: 'custom', path: ['observability_metadata'], message: 'Invalid observability metadata header' }]);
    }
    body.observability_metadata = { ...parsed, ...body.observability_metadata };
  }
  if (parent && !body.observability_parent_span_context) body.observability_parent_span_context = parent;
  return body;
}
