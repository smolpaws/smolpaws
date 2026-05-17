import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMessageContent } from './db.js';

type TestWebMessage = Parameters<typeof extractMessageContent>[0];
type TestMessage = NonNullable<TestWebMessage['message']>;

function webMessage(message: TestMessage): TestWebMessage {
  return { message } as TestWebMessage;
}

test('extracts document captions for stored WhatsApp message content', () => {
  assert.equal(
    extractMessageContent(webMessage({
      documentMessage: {
        mimetype: 'application/pdf',
        caption: '@smolpaws please read the attachment',
      },
    })),
    '@smolpaws please read the attachment',
  );
});

test('extracts wrapped document captions from Baileys future-proof messages', () => {
  assert.equal(
    extractMessageContent(webMessage({
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            mimetype: 'application/pdf',
            caption: '@smolpaws wrapped caption',
          },
        },
      },
    })),
    '@smolpaws wrapped caption',
  );
});

test('does not recurse forever when wrapped message objects point back to themselves', () => {
  const nested: TestMessage = {};
  nested.documentWithCaptionMessage = { message: nested };

  assert.equal(extractMessageContent(webMessage(nested)), '');
});

test('keeps existing text and media caption extraction behavior', () => {
  assert.equal(extractMessageContent(webMessage({ conversation: 'plain text' })), 'plain text');
  assert.equal(
    extractMessageContent(webMessage({ extendedTextMessage: { text: 'extended text' } })),
    'extended text',
  );
  assert.equal(
    extractMessageContent(webMessage({ imageMessage: { caption: 'image caption' } })),
    'image caption',
  );
  assert.equal(
    extractMessageContent(webMessage({ videoMessage: { caption: 'video caption' } })),
    'video caption',
  );
});
