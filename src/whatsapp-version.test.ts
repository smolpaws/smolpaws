import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWhatsAppVersion } from './whatsapp-version.js';

function assertVersion(
  actual: readonly number[],
  expected: readonly [number, number, number],
): void {
  assert.equal(actual.length, 3);
  assert.equal(actual[0], expected[0]);
  assert.equal(actual[1], expected[1]);
  assert.equal(actual[2], expected[2]);
}

test('uses the live WhatsApp Web revision when available', async () => {
  let fallbackCalls = 0;
  const result = await resolveWhatsAppVersion({
    fetchWhatsAppWebVersion: async () => ({
      version: [2, 3000, 111],
      isLatest: true,
    }),
    fetchBaileysVersion: async () => {
      fallbackCalls += 1;
      return { version: [2, 3000, 222], isLatest: true };
    },
  });

  assert.equal(result.source, 'whatsapp-web');
  assertVersion(result.version, [2, 3000, 111]);
  assert.equal(fallbackCalls, 0);
});

test('falls back to Baileys upstream when WhatsApp sw.js is unavailable', async () => {
  const result = await resolveWhatsAppVersion({
    fetchWhatsAppWebVersion: async () => ({
      version: [2, 3000, 111],
      isLatest: false,
      error: new Error('HTTP 500'),
    }),
    fetchBaileysVersion: async () => ({
      version: [2, 3000, 222],
      isLatest: true,
    }),
  });

  assert.equal(result.source, 'baileys-upstream');
  assertVersion(result.version, [2, 3000, 222]);
});

test('falls back when the WhatsApp Web fetcher throws', async () => {
  const result = await resolveWhatsAppVersion({
    fetchWhatsAppWebVersion: async () => {
      throw new Error('network timeout');
    },
    fetchBaileysVersion: async () => ({
      version: [2, 3000, 222],
      isLatest: true,
    }),
  });

  assert.equal(result.source, 'baileys-upstream');
  assertVersion(result.version, [2, 3000, 222]);
});

test('falls back when the WhatsApp Web fetcher returns no result', async () => {
  const result = await resolveWhatsAppVersion({
    fetchWhatsAppWebVersion: async () => undefined as never,
    fetchBaileysVersion: async () => ({
      version: [2, 3000, 222],
      isLatest: true,
    }),
  });

  assert.equal(result.source, 'baileys-upstream');
  assertVersion(result.version, [2, 3000, 222]);
});

test('fails closed when neither source can provide a current revision', async () => {
  await assert.rejects(
    resolveWhatsAppVersion({
      fetchWhatsAppWebVersion: async () => ({
        version: [2, 3000, 111],
        isLatest: false,
      }),
      fetchBaileysVersion: async () => ({
        version: [2, 3000, 222],
        isLatest: false,
      }),
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(
        error.message,
        /Unable to resolve a current WhatsApp Web client version/,
      );
      assert.match(
        String(error.cause),
        /Baileys upstream returned non-current client version 2\.3000\.222/,
      );
      assert(error.cause instanceof Error);
      assert.match(
        String(error.cause.cause),
        /WhatsApp Web returned non-current client version 2\.3000\.111/,
      );
      return true;
    },
  );
});
