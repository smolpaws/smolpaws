---
name: agent-sdk
description: Current TypeScript OpenHands SDK transpilation, profile/secret boundaries, and upstream maintenance rules.
metadata:
  tags: openhands-agent, agent-sdk, typescript, transpilation, llm-profiles
  source: https://github.com/enyst/openhands-agent
---

# OpenHands Agent SDK (TypeScript)

Use this skill when working with `@smolpaws/openhands-agent`, the SDK vendored by `packages/openhands-agent-server`, or the Python-to-TypeScript transpilation relationship.

## Authoritative sources

- Source repository: [`enyst/openhands-agent`](https://github.com/enyst/openhands-agent)
- Compatibility contract: [`docs/TRANSPILE_CONTRACT.md`](https://github.com/enyst/openhands-agent/blob/main/docs/TRANSPILE_CONTRACT.md)
- Current architecture: [`docs/ARCHITECTURE.md`](https://github.com/enyst/openhands-agent/blob/main/docs/ARCHITECTURE.md)
- Drift-tooling design: [`docs/DRIFT_TOOLING.md`](https://github.com/enyst/openhands-agent/blob/main/docs/DRIFT_TOOLING.md)

The copy under `packages/openhands-agent-server/vendor/openhands-agent/` is a built dependency, not the SDK source tree.

## Durable rules

- Preserve observable Python SDK behavior unless a named `DEV-*` or `EXC-*` policy says otherwise.
- Port upstream behavior tests-first/red-green.
- Product and REST callers select `LLMProfile` records; low-level provider clients are advanced/testing surfaces.
- Persist secret references, never raw API keys, in profiles, settings, events, logs, or snapshots.
- Provider clients own their native request, tool, continuation, reasoning, and caching semantics.
- Do not revive confirmation/security-analyzer runtime behavior through a compatibility shortcut.
- Never update from an unbounded moving `HEAD`; review a finite `OLD_PIN..NEW_PIN` interval.

## References

- [references/agent-sdk-llm-settings.md](references/agent-sdk-llm-settings.md) — stable profile and secret invariants.
- [references/agent-sdk-transpilation.md](references/agent-sdk-transpilation.md) — source/build and pin-advance workflow.
