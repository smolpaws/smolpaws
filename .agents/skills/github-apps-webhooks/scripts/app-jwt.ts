// Generate a GitHub App JWT (RS256).
import crypto from "node:crypto";
import fs from "node:fs";

function base64Url(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = base64Url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

if (process.argv[1]?.endsWith("app-jwt.ts")) {
  const appId = process.env.GITHUB_APP_ID ?? "YOUR_APP_ID";
  const keyPath = process.env.GITHUB_APP_KEY_PATH ?? "./private-key.pem";
  const key = fs.readFileSync(keyPath, "utf8");
  console.log(createAppJwt(appId, key));
}
