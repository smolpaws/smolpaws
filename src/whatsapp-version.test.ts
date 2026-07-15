import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWhatsAppVersion } from './whatsapp-version.js';

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

  assert.deepEqual(result, {
    version: [2, 3000, 111],
    source: 'whatsapp-web',
  });
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

  assert.deepEqual(result, {
    version: [2, 3000, 222],
    source: 'baileys-upstream',
  });
});

test('fails closed when neither source can provide a current revision', async () => {
  await assert.rejects(
    resolveWhatsAppVersion({
      fetchWhatsAppWebVersion: async () => ({
        version: [2, 3000, 111],
        isLatest: false,
        error: new Error('web unavailable'),
      }),
      fetchBaileysVersion: async () => ({
        version: [2, 3000, 111],
        isLatest: false,
        error: new Error('upstream unavailable'),
      }),
    }),
    /Unable to resolve a current WhatsApp Web client version/,
  );
});
