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

function readAggregateFailures(error: Error): unknown[] {
  const cause = error.cause;
  assert(cause && typeof cause === 'object');
  assert('errors' in cause);
  return Array.from((cause as { errors: Iterable<unknown> }).errors);
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

test('falls back when WhatsApp Web marks a malformed version as latest', async () => {
  const result = await resolveWhatsAppVersion({
    fetchWhatsAppWebVersion: async () => ({
      version: [2, 3000] as never,
      isLatest: true,
    }),
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
      const failures = readAggregateFailures(error);
      assert.equal(failures.length, 2);
      assert.match(
        String(failures[1]),
        /Baileys upstream returned unusable client version 2\.3000\.222/,
      );
      assert.match(
        String(failures[0]),
        /WhatsApp Web returned unusable client version 2\.3000\.111/,
      );
      return true;
    },
  );
});

test('fails closed when Baileys marks a malformed version as latest', async () => {
  await assert.rejects(
    resolveWhatsAppVersion({
      fetchWhatsAppWebVersion: async () => ({
        version: [2, 3000, 111],
        isLatest: false,
      }),
      fetchBaileysVersion: async () => ({
        version: [2, 3000] as never,
        isLatest: true,
      }),
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      const failures = readAggregateFailures(error);
      assert.equal(failures.length, 2);
      assert.match(
        String(failures[1]),
        /Baileys upstream returned unusable client version unknown/,
      );
      return true;
    },
  );
});

test('preserves both failures when the Baileys upstream fetcher throws', async () => {
  const webFailure = new Error('HTTP 500');
  const upstreamFailure = { message: 'DNS lookup failed' };

  await assert.rejects(
    resolveWhatsAppVersion({
      fetchWhatsAppWebVersion: async () => {
        throw webFailure;
      },
      fetchBaileysVersion: async () => {
        throw upstreamFailure;
      },
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      const failures = readAggregateFailures(error);
      assert.equal(failures.length, 2);
      assert.equal(failures[0], webFailure);
      assert.equal(failures[1], upstreamFailure);
      return true;
    },
  );
});
