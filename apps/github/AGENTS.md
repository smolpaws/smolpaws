# GitHub ingress

This Cloudflare Worker verifies GitHub webhooks, applies ingress allowlists, queues work, and polls
notifications for mentions. It forwards accepted work to the product host's durable relay.

- Worker client: `src/agentServerClient.ts`
- Shared HTTP handoff: `src/shared/webhookRelay.ts` at the repository root
- Host intake and delivery: `apps/relay-server/src/webhookBridges.ts`
- Worker config: `wrangler.toml`

The Worker needs `GITHUB_WEBHOOK_SECRET`, `SMOLPAWS_RELAY_SERVER_URL`, and
`SMOLPAWS_RELAY_SERVER_API_KEY`. `GITHUB_USER_TOKEN` enables notification polling.
The host needs `GITHUB_USER_TOKEN` for notification-origin replies, or `GITHUB_APP_ID` plus
`GITHUB_APP_PRIVATE_KEY` for webhook installation replies. Installation identity comes from the
verified webhook; credentials never enter the intake payload or relay database.

The Worker acknowledges its Cloudflare queue only after the host returns 202 with `accepted: true`.
It does not poll conversation completion or post comments. The host's DeliveryDispatcher owns sends
and parks uncertain deliveries instead of blindly repeating them.

```sh
npm run github:dev
npm run github:test
npm run typecheck --prefix apps/github
```

The local host is `http://127.0.0.1:8790` (`npm run relay-server:start`). Configure an authenticated
reachable host URL for a deployed Worker; do not deploy or enable ingress without authorization.
`npm run github:deploy` deploys the Worker when explicitly requested.
