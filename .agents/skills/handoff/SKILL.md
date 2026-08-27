---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
triggers:
- /handoff
license: MIT
metadata:
  tags: handoff, continuity, multi-agent, context, summary
  source: mattpocock/skills (productivity/handoff)
  invocation: explicit-only
argument-hint: "What will the next session be used for?"
---

# Handoff

> **Invocation.** Explicit only — run this when the user asks for a handoff (a `/handoff` trigger or a direct request). Don't launch it proactively.

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the OS temporary directory (e.g. `/tmp`), **not** the current workspace.

Include a **"Suggested skills"** section listing skills the next agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information — API keys, tokens, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
