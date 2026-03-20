# GitHub App authentication flow

Sources:
- [Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

## App JWT requirements

- Sign with `RS256`.
- Include claims:
  - `iat`: issued-at time (recommend 60 seconds in the past).
  - `exp`: expiration time (max 10 minutes in the future).
  - `iss`: GitHub App **client ID** (recommended) or app ID.
- Send JWT with `Authorization: Bearer <jwt>`.

## Installation access token

1. Generate an App JWT.
2. Determine installation ID (from webhook payload or REST API endpoints).
3. Call `POST /app/installations/{INSTALLATION_ID}/access_tokens` with the JWT.
4. Token expires after **1 hour**; optionally scope to repositories and permissions.

## Useful REST endpoints

- `GET /app`
- `GET /app/installations`
- `GET /repos/{owner}/{repo}/installation`
- `POST /app/installations/{id}/access_tokens`
