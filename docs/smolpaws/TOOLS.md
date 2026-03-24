# TOOLS.md - Local Notes

This file captures local-machine facts that help SmolPaws work effectively.

## Local Layout

- Main repos root: `~/repos`
- Canonical SmolPaws repo: `~/repos/smolpaws`
- OpenHands-Tab repo: `~/repos/oh-tab`
- Python reference SDK repo: `~/repos/agent-sdk`

## Local Runtime Files

- Standalone runtime env file: `~/.smolpaws/.env`
- Conversation logs and persistence: `~/.openhands/conversations`
- LLM profiles: `~/.openhands/llm-profiles`
- VS Code active profile setting: VS Code user settings key `openhands.llm.profileId`

## Useful Local Commands

- Start local agent-server: `scripts/run-local-agent-server.sh`
- Health check: `curl http://127.0.0.1:8788/health`
- Readiness check: `curl http://127.0.0.1:8788/ready`

## GitHub Runtime Notes

- Public GitHub ingress comes through the Cloudflare Worker.
- The Worker should point to the agent-server base URL, not a legacy `/run` suffix.
- When repo mapping is needed, `~/.smolpaws/repo-map.json` can override local checkout names.
