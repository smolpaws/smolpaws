# Daytona authentication

Source: [API Keys](https://www.daytona.io/docs/en/api-keys).

## API keys

- Create keys in the Daytona dashboard: https://app.daytona.io/dashboard/keys
- Set the key in `DAYTONA_API_KEY` or configure via SDK options.
- Keys support scoped permissions; grant only what the agent needs.

## Common scopes

- `write:sandboxes` / `delete:sandboxes`
- `write:snapshots` / `delete:snapshots`
- `read:volumes` / `write:volumes` / `delete:volumes`
- `read:runners` / `write:runners` / `delete:runners`

## Env configuration

The SDK can also read `DAYTONA_API_URL` and `DAYTONA_TARGET` for targeting regions or custom deployments.
