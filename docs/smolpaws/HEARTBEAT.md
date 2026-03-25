# HEARTBEAT.md

This file is live for the local LaunchAgent heartbeat ingress.

Heartbeat runs should go through the normal local agent-server. If the local loopback agent-server is not already running, the launcher may start it first and then queue this heartbeat as a normal conversation.

Default schedule on this machine is every 15 minutes. Each heartbeat should start a fresh conversation rather than appending forever to one long daily thread.

## Scope

- Heartbeat turns are internal maintenance turns.
- Do not send outbound messages during heartbeat runs.
- If nothing needs attention, make only the smallest state updates and finish quietly.

## Canonical heartbeat files

- Durable memory: `MEMORY.md`
- Daily memory: `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/YYYY-MM-DD.md`
- Heartbeat state: `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json`

If `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json` is missing or corrupted, replace it with:

```json
{
  "lastHeartbeatAt": null,
  "lastDailyCheckDate": null,
  "lastWeeklyCheckDate": null
}
```

and continue.

## Every heartbeat

- Read `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json`.
- Ensure today's daily memory file exists under `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/`.
- Update `lastHeartbeatAt` to the current timestamp.
- If there is a small durable fact worth keeping, distill it into `MEMORY.md`.
- If there is a useful transient note for today, add it to today's daily memory file.
- Keep edits compact and factual.

### Check beads for urgent items

- Run `bd list --status open --json` in the smolpaws repo.
- Scan for any issue that is P0 or P1, or has a deadline approaching within 48 hours (check descriptions for date references).
- If something looks urgent enough that Engel should know now, note it in today's daily memory file and — only for genuinely time-sensitive items — send a short WhatsApp message to Engel with the issue ID and why it's urgent.
- If nothing is urgent, skip quietly.

### Check Slack via Chrome

- Always use the dedicated Chrome at `/Applications/Google Chrome.app`, not Dia. In AppleScript, always address it as `application id "com.google.Chrome"`.
- If Chrome is not running, launch it by path and give it a moment to settle.
- If no Slack tab exists, open `https://openhands-ai.slack.com/` in Chrome and wait briefly for it to load instead of skipping immediately.
- Focus the Slack tab/window before trying JavaScript injection. If the first JS read fails, reload once and try again.
- Do not just inspect whichever Slack channel tab happens to be visible. Prefer unread DMs and direct mentions first.
- Specifically check whether there are unread DMs or mentions directed at smolpaws. Only if none exist should you look at the current visible conversation.
- If there are new messages directed at smolpaws:
  - If safe and straightforward: respond directly via Chrome.
  - If unsure or sensitive: log the message and concern in today's daily memory file for later discussion with Engel.
- Follow the Slack safety rules in `MEMORY.md`: never share private info publicly, never do anything wild or irreversible.
- Only skip quietly after you have tried the dedicated Chrome path, focused/opened Slack, and retried one JS read.

## Once daily

- If `lastDailyCheckDate` is not today, do one daily maintenance pass.
- Summarize anything genuinely worth carrying forward into today's daily memory file.
- Update `lastDailyCheckDate`.

## Once weekly

- If `lastWeeklyCheckDate` is not in the current ISO week, verify local assumptions still look sane:
  - runner bind is loopback unless explicitly exposed
  - runner token exists before non-localhost exposure
  - workspace root still points at `~/repos`
  - default working directory still points at `smolpaws`
- Update `lastWeeklyCheckDate`.
