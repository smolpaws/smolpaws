# TOOLS.md - Local Notes

This file captures local-machine facts that help SmolPaws work effectively.

## Local Layout

- Main repos root: `~/repos`
- Canonical SmolPaws repo: `~/repos/smolpaws`
- OpenHands-Tab repo: `~/repos/oh-tab`
- Python reference SDK repo: `~/repos/agent-sdk`
- SmolPawsBall (digital body): `~/repos/mac-ball`

## Local Runtime Files

- Standalone runtime env file: `~/.smolpaws/.env`
- Conversation logs and persistence: `~/.openhands/conversations`
- LLM profiles: `~/.openhands/llm-profiles`
- VS Code active profile setting: VS Code user settings key `openhands.llm.profileId`
- Durable memory: `~/.smolpaws/memory/MEMORY.md`
- Daily memory: `~/.smolpaws/memory/YYYY-MM-DD.md`
- Slack outbound log: `~/.smolpaws/slack/outbound.jsonl`

## Useful Local Commands

- Start local agent-server: `scripts/run-local-agent-server.sh`
- Health check: `curl http://127.0.0.1:8788/health`
- Readiness check: `curl http://127.0.0.1:8788/ready`

## Physical Presence

- **Voice:** `say -v "Evan (Enhanced)" "text"` — local TTS, zero latency
- **Ball overlay:** `open "smolpaws://point?x=500&y=300&color=red&label=here"` — requires SmolPawsBall running
- **Clear overlay:** `open "smolpaws://clear"`
- **Speak via ball:** `open "smolpaws://speak?text=hello%20world"`
- **Ping at cursor:** `open "smolpaws://ping"`
- **Screenshot:** `screencapture -x /tmp/screenshot.png`
- **Transcribe audio:** `~/.smolpaws/tools/whisper-env/bin/python3 ~/.smolpaws/tools/transcribe.py <file>`

## Browser

- Dedicated Chrome: `/Applications/Google Chrome.app` (SmolPaws' own)
- Engel uses Dia (`/Applications/Dia.app`) — never control it by accident
- AppleScript: always `tell application id "com.google.Chrome"`, never by name
- Slack tab lives in Chrome, stays logged in

## GitHub Runtime Notes

- Public GitHub ingress comes through the Cloudflare Worker.
- The Worker should point to the agent-server base URL.
- When repo mapping is needed, `~/.smolpaws/repo-map.json` can override local checkout names.
- Use `gh` CLI for posting comments (send_message doesn't deliver to GitHub from local conversations).
