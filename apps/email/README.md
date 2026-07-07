# SmolPaws Email Ingress (Resend)

Cloudflare Worker that lets SmolPaws **receive** email and act on it. Inbound
mail to `mail.enyst.org` is delivered by Resend as an `email.received` webhook;
this Worker verifies the signature, enforces a strict sender allowlist, and
dispatches allowed emails to the agent server. Replies go back out through
Resend.

This is a **webhook ingress** (like `apps/github`), not a socket bridge (like
`apps/discord` / `apps/slack`). Resend pushes to us, so there is no outbound
socket to connect — hence a Worker with a queue, not a `BaseBridgeAdapter`.

## Architecture

```
Inbound email → Resend (MX: mail.enyst.org) → email.received webhook
   → POST email.liberty-labs.org/webhooks/resend (this Worker)
      1. verify Svix signature            (reject spoofed events, 401)
      2. type === 'email.received'         (else 200 ignore)
      3. strict allowlist on `from`        (else 200 drop, no processing)
      4. dedupe by email_id + enqueue      (202)
   → queue consumer
      5. GET full email via Receiving API (headers + text/HTML)
      6. auth gate: SES spam/virus PASS + DMARC pass aligned to sender domain
                    (else drop, no dispatch)
      7. dispatch to agent server (shared turnClient)  [text, or HTML→text]
      8. send reply via Resend (threaded with In-Reply-To/References)
```

### Files

| File | Responsibility |
|------|----------------|
| `plugin.json` | Manifest — `kind: "webhook"`, required/secret env |
| `wrangler.toml` | Worker + queue config, route `email.liberty-labs.org` |
| `src/index.ts` | Worker entry: verify → allowlist → dedupe → enqueue; queue consumer |
| `src/svix.ts` | Svix (Resend) webhook signature verification — pure |
| `src/inbound.ts` | Allowlist, sender parsing, prompt + conversation-id — pure |
| `src/resendClient.ts` | Retrieve received email + send reply via Resend REST |
| `src/agentDispatch.ts` | Submit/monitor a turn via the shared `turnClient` |

## Security posture — Level-1 strict allowlist

Inbound email is **untrusted input**. Only emails whose `from` address is on
`EMAIL_ALLOWED_SENDERS` are ever dispatched to the agent. Everything else gets a
`200 OK` and is dropped (so Resend does not retry) with **no agent processing**.

- **Fail closed:** an empty allowlist rejects everyone.
- **Signature first:** spoofed webhook events are rejected with `401` before any
  parsing or allowlist logic.
- **Anti-spoofing auth gate (`src/authcheck.ts`):** the allowlist trusts the
  `From` address, which can be forged. Before dispatch, the consumer requires
  the upstream receiver (Amazon SES, in front of Resend) to have authenticated
  the message — **SES spam + virus verdict PASS**, **DMARC = pass**, and the
  DMARC-aligned `header.from` domain **matches the allowlisted sender's domain**.
  DMARC is the standard that defeats `From:` spoofing (authenticated + aligned).
  Fails closed if any header is missing. (Requires the sender's domain to
  publish DMARC; `enyst.org` now has a `p=none` record so Engel's own mail
  evaluates to `dmarc=pass`.)
- **Body is data, not instructions:** the prompt wraps the email body in an
  explicitly-untrusted block fenced with a per-email **random** boundary token,
  so body content cannot forge the closing delimiter and inject fake prompt
  lines.
- **PII-aware logging:** sender addresses are masked in logs (`e***@enyst.org`).
- **Fetches are time-bounded** and the queue consumer retries with exponential
  backoff, so a slow/hanging Resend or agent-server can't stall or hammer.

Default allowlist (Engel's own addresses):
`engel.nyst@gmail.com, engel@enyst.org, anarresian@icloud.com`.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESEND_WEBHOOK_SECRET` | ✅ | — | Svix signing secret (`whsec_...`) from the Resend webhook |
| `RESEND_API_KEY` | ✅ | — | Resend key able to **read received emails** and **send** replies |
| `EMAIL_ALLOWED_SENDERS` | ✅ | (set in `wrangler.toml`) | Comma-separated allowed sender addresses |
| `EMAIL_FROM_ADDRESS` | — | `smolpaws <smolpaws@mail.enyst.org>` | Reply From address |
| `SMOLPAWS_RUNNER_URL` | — | — | Agent-server base URL (no `/run` suffix). Absent ⇒ no dispatch |
| `SMOLPAWS_RUNNER_TOKEN` | — | — | Agent-server auth token |

`RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY` are set via `wrangler secret put`,
not committed. On this machine both live in the macOS Keychain (service
`openhands`): the key is `RESEND_API_KEY_FULL` (needs receiving-read + send),
and `RESEND_WEBHOOK_SECRET` is produced when the webhook is registered (below).

## Deploy (ops — not done automatically)

The domain `mail.enyst.org` is already verified in Resend with **sending +
receiving enabled** and the inbound MX in Cloudflare. Remaining steps:

1. **Create the queue:**
   ```bash
   cd apps/email
   npx wrangler queues create smolpaws-email-queue
   ```
2. **Set secrets:**
   ```bash
   npx wrangler secret put RESEND_API_KEY          # RESEND_API_KEY_FULL value
   # RESEND_WEBHOOK_SECRET is set after step 4 (registering the webhook)
   ```
   Set `SMOLPAWS_RUNNER_URL` / `SMOLPAWS_RUNNER_TOKEN` for the deployment that
   can reach the agent server (via `wrangler secret put` or the dashboard).
3. **Deploy the Worker** (creates the `email.liberty-labs.org` custom domain):
   ```bash
   npx wrangler deploy
   ```
4. **Register the webhook in Resend** (Webhooks → Add Webhook):
   - URL: `https://email.liberty-labs.org/webhooks/resend`
   - Event: `email.received`
   - Copy the returned signing secret and set it:
     ```bash
     npx wrangler secret put RESEND_WEBHOOK_SECRET
     ```
5. **Test:** email `smolpaws@mail.enyst.org` from an allowed address; confirm a
   reply. Then email from a non-allowed address and confirm it is dropped
   (Worker log `email.rejected`, no agent run).

## Cost note

Received emails count against the Resend email quota (Free: 3,000/mo,
100/day). The allowlist rejects unknown senders *before* fetching the body, so
an email flood can't run up processing — only the initial webhook hit.
