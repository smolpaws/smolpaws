// Verify GitHub webhook signatures with HMAC-SHA256.
import crypto from "node:crypto";

export function verifySignature(payload: string, secret: string, signatureHeader: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");

  const expected = `sha256=${digest}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

if (process.argv[1]?.endsWith("verify-webhook.ts")) {
  const payload = "Hello, World!";
  const secret = "It's a Secret to Everybody";
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  console.log("Valid:", verifySignature(payload, secret, signature));
}
