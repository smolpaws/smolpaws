// Minimal Cloudflare Queues example.
// Producer: send messages in fetch handler.
// Consumer: process messages in queue handler.

interface Env {
  MY_QUEUE: Queue<{ message: string }>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      await env.MY_QUEUE.send({ message: "hello from queues" });
      return new Response("queued", { status: 202 });
    }

    return new Response("ok", { status: 200 });
  },

  async queue(batch: MessageBatch<{ message: string }>, _env: Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      ctx.waitUntil(
        (async () => {
          console.log("Received", message.body.message, "attempt", message.attempts);
          message.ack();
        })(),
      );
    }
  },
} satisfies ExportedHandler<Env>;
