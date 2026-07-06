import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { decodeSvixSecret, timingSafeEqual, verifySvixSignature } from '../svix.js';

/** Produce a valid Svix signature the way the sender would. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
  const keyBytes = decodeSvixSecret(secret);
  const signed = `${id}.${timestamp}.${body}`;
  const sig = createHmac('sha256', Buffer.from(keyBytes)).update(signed).digest('base64');
  return `v1,${sig}`;
}

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;

test('verifySvixSignature accepts a valid signature within tolerance', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = JSON.stringify({ type: 'email.received' });
  const signature = sign(SECRET, id, ts, body);

  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id, timestamp: ts, signature },
    body,
    nowSeconds: 1700000000,
  });
  assert.equal(result.valid, true);
});

test('verifySvixSignature rejects a tampered body', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = JSON.stringify({ type: 'email.received' });
  const signature = sign(SECRET, id, ts, body);

  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id, timestamp: ts, signature },
    body: body + 'tampered',
    nowSeconds: 1700000000,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'no_matching_signature');
});

test('verifySvixSignature rejects wrong secret', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = '{}';
  const signature = sign(SECRET, id, ts, body);

  const result = await verifySvixSignature({
    secret: `whsec_${randomBytes(24).toString('base64')}`,
    headers: { id, timestamp: ts, signature },
    body,
    nowSeconds: 1700000000,
  });
  assert.equal(result.valid, false);
});

test('verifySvixSignature rejects out-of-tolerance timestamp', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = '{}';
  const signature = sign(SECRET, id, ts, body);

  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id, timestamp: ts, signature },
    body,
    nowSeconds: 1700000000 + 10 * 60, // 10 minutes later
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('verifySvixSignature rejects missing headers', async () => {
  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id: null, timestamp: null, signature: null },
    body: '{}',
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_svix_headers');
});

test('verifySvixSignature accepts when one of several signatures matches', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = '{}';
  const good = sign(SECRET, id, ts, body);
  const signature = `v1,AAAObviouslyWrong ${good}`;

  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id, timestamp: ts, signature },
    body,
    nowSeconds: 1700000000,
  });
  assert.equal(result.valid, true);
});

test('verifySvixSignature rejects a timestamp with trailing garbage', async () => {
  const id = 'msg_123';
  const ts = '1700000000';
  const body = '{}';
  const signature = sign(SECRET, id, ts, body);

  const result = await verifySvixSignature({
    secret: SECRET,
    headers: { id, timestamp: `${ts}xyz`, signature },
    body,
    nowSeconds: 1700000000,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_timestamp');
});

test('timingSafeEqual basic behavior', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
});
