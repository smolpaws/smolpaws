# smolpaws 🐾

> *smol paws, big help.*

**smolpaws** is a small, local-first agent with WhatsApp, Slack, and Discord bridges. Its chat runtime uses our [TypeScript OpenHands SDK](https://github.com/smolpaws/openhands-agent), transpiled from the [OpenHands Python SDK](https://github.com/OpenHands/software-agent-sdk). We just added toe beans.

Think of it as a cat that *does things* instead of just knocking stuff off your computer. OK, also knocking stuff off your computer.

Because when OpenHands says 🙌, we say <img src="assets/paws-silver.svg" alt="paws" height="18" style="vertical-align: middle;" />.

## Vibes

- 🐟 **Open source** — No closed doors. Cats hate closed doors.
- 🧶 **Curious** — Will poke at your code until it works.
- 😺 **Chill** — Just vibes and working software. Or passing tests, anyway. My tests.
- 🌙 **Nocturnal-friendly** — Available for your 3am debugging sessions.

We're smol. We're helpful. We have beans.

## Start here

WhatsApp is the primary channel. Follow the [WhatsApp guide](docs/whatsapp/README.md) for dependencies, device linking, chat registration, profiles, and startup.

- [Slack setup](docs/slack/instructions.md)
- [Discord setup](apps/discord/README.md)
- [Model and profile selection](docs/models.md)
- [Identity and memory context](docs/context-files.md)
- [Documentation index](docs/README.md)

Normal chat operation uses the standalone bridges, such as `npm run whatsapp:start`. The root `npm start` and `npm run dev` entry points run the legacy WhatsApp process; see the WhatsApp guide before starting on an existing account.

## What lives here

The chat bridges send messages through the durable Message Relay to a shared TypeScript agent-server. Agent execution happens on the host machine; the Cloudflare Workers handle webhook ingress.

| Component | Source |
|---|---|
| Standalone chat bridges | [WhatsApp](apps/whatsapp/), [Slack](apps/slack/), [Discord](apps/discord/) |
| Durable message intake, delivery, and scheduling | [Message Relay](src/coordinator/) |
| OpenHands REST/WebSocket server | [Agent-server package](packages/openhands-agent-server/) |
| GitHub and email webhook ingress | [GitHub Worker](apps/github/), [Email Worker](apps/email/) |

See [bridge startup and shared runtime](docs/bridges.md) and the [agent-server architecture](packages/openhands-agent-server/docs/ARCHITECTURE.md) for the boundaries between them.

## Development checks

From the repository root:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm run ci --prefix packages/openhands-agent-server
npm run typecheck
```

The server gate includes tests, OpenAPI parity, typechecks, lint, build, and package smoke checks. It builds the server package before the root typecheck needs it. Channel guides list their own dependencies and verification commands.

## Status

```
   /\_/\
  ( o.o ) < still making biscuits...
   > ^ <
```

---

*Made with 😸 by someone who should probably be sleeping*
