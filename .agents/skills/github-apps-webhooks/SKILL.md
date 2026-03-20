---
name: github-apps-webhooks
description: Build and operate GitHub Apps with webhook validation, JWT auth, and installation tokens. Use when integrating GitHub webhooks or GitHub App authentication.
metadata:
  tags: github, webhooks, github-apps, jwt, installation-token
  source: https://docs.github.com/en/apps/creating-github-apps/
---

# GitHub Apps & Webhooks

Use this skill when you need to validate GitHub webhook deliveries, generate GitHub App JWTs, or exchange installation access tokens.

## Key steps

1. **Validate webhooks** using `X-Hub-Signature-256` and HMAC-SHA256.
2. **Generate a GitHub App JWT** signed with `RS256` (claims: `iat`, `exp`, `iss`).
3. **Create an installation access token** via `POST /app/installations/{id}/access_tokens`.

## References

- [references/webhooks-validation.md](references/webhooks-validation.md) - Webhook signature validation guidance.
- [references/github-app-auth.md](references/github-app-auth.md) - JWT and installation token flow.

## Scripts

- [scripts/verify-webhook.ts](scripts/verify-webhook.ts) - HMAC signature verification helper.
- [scripts/app-jwt.ts](scripts/app-jwt.ts) - JWT generation example for GitHub Apps.
