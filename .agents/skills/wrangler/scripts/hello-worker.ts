// Minimal Cloudflare Worker example. Run with: npx wrangler dev
export interface Env {
  // Add bindings here, e.g. KV: KVNamespace;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response("Hello from Workers!", { status: 200 });
  },
};
