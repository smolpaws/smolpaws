---
name: cloudflare-queues
description: Cloudflare Queues messaging on Workers, including producer/consumer bindings, queue handlers, batching, retries, and dead-letter queues. Use when building or configuring Cloudflare Queue workflows.
metadata:
  tags: cloudflare, queues, workers, messaging
  source: https://developers.cloudflare.com/queues/
---

# Cloudflare Queues

Use this skill when you need to configure or implement Cloudflare Queues with Workers, including producer bindings, consumer handlers, retries, or dead-letter queues.

## Key concepts

- **Producer Worker**: sends messages with `env.MY_QUEUE.send()` or `sendBatch()`.
- **Consumer Worker**: defines a `queue(batch, env, ctx)` handler to process message batches.
- **Bindings**: configured in `wrangler.jsonc` (or `wrangler.toml`) for producers and consumers.
- **Retries & DLQ**: configure `max_retries` and `dead_letter_queue` in the consumer binding.

## References

- [references/queues-docs.md](references/queues-docs.md) - Official Cloudflare Queues docs highlights.

## Scripts

- [scripts/queues-worker.ts](scripts/queues-worker.ts) - Producer + consumer Worker example.

## Checklist

1. Add producer binding (`queues.producers`) to the Worker config.
2. Add consumer binding (`queues.consumers`) with batch size/timeouts.
3. Implement `queue()` handler for consumers.
4. Use `ctx.waitUntil()` for async side work.
5. Configure retries and optional dead-letter queue.
