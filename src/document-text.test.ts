import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOCX_MIME,
  isReadableDocumentMedia,
  MAX_DOCUMENT_TEXT_CHARS,
} from './document-text.js';

test('only docx media is treated as readable document media', () => {
  assert.equal(isReadableDocumentMedia(DOCX_MIME), true);
  assert.equal(isReadableDocumentMedia('image/png'), false);
  assert.equal(isReadableDocumentMedia(undefined), false);
});

test('document text cap stays bounded for chat context', () => {
  assert.equal(MAX_DOCUMENT_TEXT_CHARS <= 20_000, true);
});
