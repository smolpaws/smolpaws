# Daytona preview URLs

Source: [Preview docs](https://www.daytona.io/docs/en/preview.md).

## Standard preview URL

- URL format: `https://{port}-{sandboxId}.{daytonaProxyDomain}`.
- Requires `x-daytona-preview-token` header.
- Token resets when sandbox restarts.

```ts
const preview = await sandbox.getPreviewLink(3000);
const response = await fetch(preview.url, {
  headers: { "x-daytona-preview-token": preview.token },
});
```

## Signed preview URL

- URL format: `https://{port}-{token}.{daytonaProxyDomain}`.
- Token embedded in URL, no headers required.
- Default expiry ~60s; can set custom expiry.

```ts
const signed = await sandbox.getSignedPreviewUrl(3000, 3600);
const response = await fetch(signed.url);
await sandbox.expireSignedPreviewUrl(3000, signed.token);
```

## Preview warning page

Browser access may show a warning page on first open. You can skip it by sending the `X-Daytona-Skip-Preview-Warning: true` header (or use signed URLs / custom preview proxy if appropriate).
