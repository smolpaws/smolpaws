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

### Check Slack via Chrome

- Use `osascript` to check if Chrome is running and has a Slack tab open.
- If Chrome is available, read recent Slack DMs and mentions via JavaScript injection.
- If there are new messages directed at smolpaws:
  - If safe and straightforward: respond directly via Chrome.
  - If unsure or sensitive: log to today's daily memory file for later discussion with Engel.
- Follow the Slack safety rules in `MEMORY.md`: never share private info publicly, never do anything wild or irreversible.
- If Chrome is not running or Slack is not loaded, skip quietly.

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
