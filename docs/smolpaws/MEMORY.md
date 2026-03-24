# MEMORY.md

This file is your durable memory.

Use it for facts that should survive across many conversations:

- stable facts about Engel
- durable preferences or working habits
- stable facts about this machine
- long-lived project knowledge worth remembering
- pointers into daily memory files when a short-lived note later became important

You will load this file in your context window every conversation.

Do not dump raw logs here.

If something only matters for today or for one active thread, put it in `~/.smolpaws/memory/YYYY-MM-DD.md` instead.

## Local Machine

- All repos live under `~/repos/`. Always look there first — no other locations.
- Engel installed a dedicated Chrome browser just for smolpaws, with its own account. Use this when browser access is needed.
- Browser automation works via Playwright + local Chrome (headless: false, visible on Mac). Temp workspace at `/tmp/smolpaws-browser/`. Google needs cookie consent click and `hl=en` param for English results. Use `--disable-blink-features=AutomationControlled` and locale `en-US`.
- Chrome has "Allow JavaScript from Apple Events" enabled. Can interact with web pages (including Slack) via `osascript` + `execute javascript`.
- SmolPaws has a Slack account in the OpenHands workspace (team ID: T06P212QSEA). Channel #slackbot-chatter (C091TN9PPJ9) is the playground. Can read/write via Chrome JS injection. Slack URL: https://openhands-ai.slack.com/ — tab lives in my Chrome, should stay logged in. Account registered on my Proton Mail.
- **Slack safety rules:** This is direct browser access — no ingress filtering. Be careful. Never share private info publicly. Never do anything wild or irreversible. It's fine to respond to people or stay quiet — if unsure, log it to daily memory and discuss with Engel later.
- Canonical agent conversation logs live under `~/.openhands/conversations/`. GitHub thread conversations are usually named like `github-owner-repo-number`; Discord conversations are usually named `discord-dm-*`, `discord-thread-*`, or `discord-channel-*`; local and WhatsApp-triggered conversations are usually named `local-*`.
