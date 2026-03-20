# Cloudflare Workers & Wrangler docs highlights

Sources: Cloudflare Workers docs for [CLI quick start](https://developers.cloudflare.com/workers/get-started/guide/), [fetch handler](https://developers.cloudflare.com/workers/runtime-apis/fetch-event/), [configuration](https://developers.cloudflare.com/workers/configuration/), and the [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/).

## Worker entrypoint basics

- Workers use module syntax with a default export that implements `fetch(request, env, ctx)` and returns a `Response`.
- The runtime provides `env` bindings (KV, D1, R2, etc.) and `ctx.waitUntil()` for background work.

## Wrangler usage

- Cloudflare recommends local installs: run with `npx wrangler ...`.
- Common commands: `wrangler init`, `wrangler dev`, `wrangler deploy`, `wrangler check`, and `wrangler types`.
- New projects are typically created with `npm create cloudflare@latest` (C3).

## Configuration reminders

- Configure your project in `wrangler.jsonc` (preferred over TOML for newer features).
- Set a `compatibility_date` and update it regularly.
- Bindings are configured in `wrangler.jsonc` (KV, D1, R2, Durable Objects, etc.).
- Use `.dev.vars` and `wrangler secret` for local and production secrets.

## Quick links

- [CLI quick start](https://developers.cloudflare.com/workers/get-started/guide/)
- [Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/fetch-event/)
- [Configuration](https://developers.cloudflare.com/workers/configuration/)
- [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/)
