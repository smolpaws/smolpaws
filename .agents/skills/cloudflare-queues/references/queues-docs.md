# Cloudflare Queues docs highlights

Sources: Cloudflare Queues [overview](https://developers.cloudflare.com/queues/), [configuration](https://developers.cloudflare.com/queues/configuration/), and [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/).

## Core model

- **Producer** Workers send messages via `env.MY_QUEUE.send()` or `sendBatch()`.
- **Consumer** Workers implement `queue(batch, env, ctx)` to process message batches.
- **Bindings** are configured in `wrangler.jsonc`/`wrangler.toml` under `queues.producers` and `queues.consumers`.

## Producer API (Workers)

- `Queue.send(body, options?)` sends one message.
- `Queue.sendBatch(messages, options?)` sends many messages.
- Default content type is `json` (changed from `v8` for compatibility dates after 2024-03-18).

## Consumer API (Workers)

- `queue(batch, env, ctx)` receives a `MessageBatch` with `messages`.
- Messages support `ack()` and `retry({ delaySeconds })`.
- Use `ctx.waitUntil()` for async side work; unhandled rejections cause retries.

## Configuration essentials

### Producer binding (JSON)

```jsonc
{
  "queues": {
    "producers": [{ "queue": "my-queue", "binding": "MY_QUEUE" }]
  }
}
```

### Consumer binding (JSON)

```jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "my-queue",
        "max_batch_size": 10,
        "max_batch_timeout": 30,
        "max_retries": 10,
        "dead_letter_queue": "my-queue-dlq"
      }
    ]
  }
}
```

### Queue settings

Use Wrangler to update queue-level settings such as delivery delay or message retention:

```
npx wrangler queues update <QUEUE-NAME> --delivery-delay-secs 60 --message-retention-period-secs 3000
```
