# Email bridge

Resend webhook → Svix verification → strict sender allowlist → Cloudflare Queue → SES/DMARC
checks and body retrieval → authenticated product-host intake → Message Relay → agent run →
host delivery outbox → Resend reply.

The Worker needs `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` (receiving access),
`EMAIL_ALLOWED_SENDERS`, `SMOLPAWS_RELAY_SERVER_URL` and `SMOLPAWS_RELAY_SERVER_API_KEY`.
Allowlisted sender values stay in Worker secrets, never committed configuration.

The host needs `RESEND_API_KEY` (sending access) and `EMAIL_FROM_ADDRESS`. It accepts
`POST /api/bridges/email/messages` only with session authentication. The Worker acknowledges its
queue only after a 202 durable acceptance receipt; it never waits for completion or sends replies.

Each email ID has its own durable lane and immutable reply-thread metadata. Duplicate handoffs
cannot append a second user event or deliver a second reply. The host keeps pending work across
restarts. An ambiguous send is parked as `delivery_unknown` for reconciliation.

```sh
npm run email:test
npm run typecheck --prefix apps/email
```

This bridge remains dormant until its new endpoint and credentials are explicitly configured and
deployed. Do not enable it, change DNS, or deploy without authorization.
