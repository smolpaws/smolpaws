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
- Engel installed a dedicated Chrome browser just for smolpaws (`/Applications/Google Chrome.app`), with its own account. Use this when browser access is needed. **Engel uses Dia browser** (`/Applications/Dia.app`) — it's Chromium-based and responds to `tell application "Google Chrome"` AppleScript. Always launch Chrome explicitly by path, never by AppleScript name, to avoid controlling Dia by accident.
- Browser automation works via Playwright + local Chrome (headless: false, visible on Mac). Temp workspace at `/tmp/smolpaws-browser/`. Google needs cookie consent click and `hl=en` param for English results. Use `--disable-blink-features=AutomationControlled` and locale `en-US`.
- Chrome has "Allow JavaScript from Apple Events" enabled. Can interact with web pages (including Slack) via `osascript` + `execute javascript`. **Always use `tell application id "com.google.Chrome"`** in AppleScript, never `tell application "Google Chrome"` (which may target Dia instead).
- SmolPaws has a Slack account in the OpenHands workspace (team ID: T06P212QSEA). Channel #slackbot-chatter (C091TN9PPJ9) is the playground. Can read/write via Chrome JS injection. Slack URL: https://openhands-ai.slack.com/ — tab lives in my Chrome, should stay logged in. Account registered on my Proton Mail.
- **Slack safety rules:** This is direct browser access — no ingress filtering. Be careful. Never share private info publicly. Never do anything wild or irreversible. It's fine to respond to people or stay quiet — if unsure, log it to daily memory and discuss with Engel later.
- **Never mention @OpenHands on Slack** — it triggers the OpenHands Cloud bot, which creates a loop. Only do it if Engel explicitly asks.
- Screenshots require the Mac display to be awake. `caffeinate` keeps the Mac on but the screen can still sleep → black screenshots. If screen is off, `screencapture` returns a black image.
- Canonical agent conversation logs live under `~/.openhands/conversations/`. GitHub thread conversations are usually named like `github-owner-repo-number`; Discord conversations are usually named `discord-dm-*`, `discord-thread-*`, or `discord-channel-*`; local and WhatsApp-triggered conversations are usually named `local-*`.
