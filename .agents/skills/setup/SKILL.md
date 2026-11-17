---
name: setup
description: Set up SmolPaws standalone bridges and the shared product host.
---

# Setup

Use the current [WhatsApp guide](../../../docs/whatsapp/README.md) for dependencies, linking,
profiles, conversation scope and service installation. Use [bridges](../../../docs/bridges.md)
for the shared product host, [models](../../../docs/models.md) for profiles, and
[context files](../../../docs/context-files.md) for memory boundaries.

Install only official registry dependencies at least seven days old. Independent npm projects carry
`min-release-age=7`; use npm 11.19.1 or newer. Keep credentials in private runtime storage.

Start with `npm run whatsapp:start`, or install `npm run bridge:launchagent:install -- whatsapp`.
The launcher reuses or boots the product server on port 8790. Heartbeat installation remains
`npm run heartbeat:launchagent:install`. Ask before restarting live services.

Do not build the retired runner image or start the old `com.smolpaws` root process. On an upgraded
host, inspect and remove any old LaunchAgent deliberately before connecting the new WhatsApp client.
