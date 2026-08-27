# apps/ — Channel bridges

Each subdirectory here is a **bridge**: it connects one external channel (Discord, Slack,
GitHub, email, …) to the shared agent-server. Bridges are how the outside world talks to
SmolPaws and how SmolPaws talks back.

## The bridge essentials — every bridge is exactly these six

Whatever the platform, a bridge always models the same six things and nothing more. Keep new
bridges to this shape; if something doesn't fit one of these, it probably belongs in the
agent-server or the ingress policy, not the bridge.

1. **Users** — who is talking. The external identity (Discord user, Slack member, email
   sender, GitHub actor). Bridges map it to something stable; they do not invent an
   authorization model of their own beyond the channel's allowlist/access check.
2. **Channels** — where the conversation happens. DM, group, thread, repo issue, mailbox.
   This is what a `conversationId` is derived from, so a channel maps to one agent-server
   conversation.
3. **Messages** — the content in both directions. Inbound is normalized to a prompt (triggers
   and mentions stripped); outbound is the agent's reply text.
4. **Events** — everything that is not a plain message: connect/disconnect, typing, edits,
   reactions, delivery/ack. Platform events in, lifecycle events out.
5. **Sending** — deliver an agent response to the platform (`sendReply`, `sendTyping`).
6. **Receiving** — listen for platform events and hand incoming messages to the agent-server
   (`connect` → platform handler → `dispatch`).

This is the deliberately small universal model (the useful essence of protocol abstractions
like Satori — we only keep these six; we do not adopt the rest). A bridge translates a
platform into these six concepts and stops there.

## Where the essentials live in this repo

The shared bridge core is in `src/shared/bridgeAdapter.ts` (not under `apps/`), and each app
subclasses it:

| Essential   | Where |
|-------------|-------|
| Users       | Adapter access checks / allowlists (e.g. `apps/slack/src/config.ts`, `apps/email` sender allowlist); carried in `IncomingMessage.platformContext` |
| Channels    | `IncomingMessage.conversationId` (e.g. `discord-dm-12345`) → one agent-server conversation |
| Messages    | `IncomingMessage.prompt` (in) / `ReplyContext` + `sendReply` (out) |
| Events      | `BaseBridgeAdapter` lifecycle (`start`/`stop`/`connect`/`disconnect`), `sendTyping`, delivery-owner monitoring |
| Sending     | `sendReply()` / `sendTyping()` — abstract, implemented per platform |
| Receiving   | `connect()` platform handler → `dispatch()` (shared: submit to agent-server, monitor turn, deliver) |

Registration and discovery: adapters self-register with `bridgeRegistry`
(`src/shared/bridgeAdapter.ts`) and are found by the loader (`src/shared/bridgeLoader.ts`) via
each app's `plugin.json` (`kind: "bridge"`).

## Two shapes of bridge

- **Socket/adapter bridges** (`apps/discord`, `apps/slack`) extend `BaseBridgeAdapter` and run
  in-process with the agent-server. This is the canonical shape — start here for a new channel.
- **Webhook Workers** (`apps/github`, `apps/email`) are Cloudflare Workers that receive
  platform webhooks and call the agent-server over HTTP. Same six essentials, different
  transport; they don't extend `BaseBridgeAdapter` because they aren't long-lived listeners.

`apps/agent-server` is not a bridge — it is the shared Fastify agent-server the bridges talk to.

## Adding a bridge

1. Model the platform in terms of the six essentials above — nothing more.
2. Prefer extending `BaseBridgeAdapter`; only reach for a Worker when the platform is
   webhook-delivered and there's no persistent socket.
3. Add a `plugin.json` with `kind: "bridge"` and `requiredEnv` so the loader can discover it.
4. Keep authorization to a channel allowlist / access check; real policy lives in the ingress
   handler, not scattered through the adapter.
5. See `apps/slack/AGENTS.md` for a worked example of the adapter pattern.
