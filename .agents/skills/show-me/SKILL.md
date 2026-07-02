---
name: show-me
description: >
  Visualize a codebase or a change as a single self-contained HTML page so a human
  grasps the big picture fast — and, when something changed, sees the before/after
  core difference clearly, grounded to the actual code. Not limited to PRs. Use when
  the user says "show me", "visualize this", "help me understand this repo / this PR",
  "draw the architecture", "what changed and how", "I don't want to read the code,
  just show me", or asks for a diagram / walkthrough / presentation of code.
triggers:
- /show-me
- /visualize
license: MIT
metadata:
  tags: visualization, html, explainer, codebase, diff, mechanism
  source: xingyaoww/show-me (skills/show-me)
---

# show-me — visualize code & changes for humans

When a human needs to *understand* code — a whole repo, a system, or a change — prose
and raw diffs are slow. The scarce resource is not the agent's work; it is the
reader's attention, reading speed, and trust budget. Spend extra agent effort to
make the page skimmable, verifiable, and easy to act on: a **single self-contained
HTML page** that conveys the **big picture** and, when relevant, the **before → after
core difference**, with every claim **clickable back to the real code**.

This file is an **index**. Read the dimension that matches the task, then read
[`references/html-craft.md`](references/html-craft.md) for how to actually build the page.

## Pick the dimension

| Situation | Read | Produces |
|---|---|---|
| **New repo / system** — first time seeing it, don't know what it does or how it works | [`references/repo-explainer.md`](references/repo-explainer.md) | A comprehensive HTML report: what it is, the mental model, architecture, data/control flow, key components — enough to orient before touching code |
| **Targeted mechanism / tricky logic** — user asks how one pipeline, extractor, state machine, scheduler, resolver, parser, scorer, or selection rule works | [`references/mechanism-explainer.md`](references/mechanism-explainer.md) | A focused walkthrough: exact inputs, state transitions, branch rules, worked examples, non-examples, outputs, and code links |
| **A change** — already understand the repo; a PR / diff / branch / uncommitted edit needs explaining | [`references/pr-explainer.md`](references/pr-explainer.md) | A change report: big-picture impact + **before/after** diagrams of the affected logic, diffs collapsed, grounded to code |

Both share the same craft (look, self-containment, before/after technique, code
grounding, serving) — that lives in [`references/html-craft.md`](references/html-craft.md).

## Non-negotiable principles (all dimensions)

1. **Optimize for scarce human attention.** The first screen should let the reader
   decide in ~15 seconds: what this is, whether it matters, where to jump next, and
   what evidence supports the claim. Do not start with your process; start with the
   conclusion, model, risk, or action.
2. **Big picture first.** Lead with the one-paragraph mental model and a top-level
   diagram. Detail comes after, and only on demand (collapsed / linked).
3. **For mechanisms, show an executable trace.** When explaining extraction,
   selection, routing, parsing, scheduling, state machines, or scoring, include a
   small worked input and walk it through the exact branches. Also show at least
   one non-example: what looks related but does not create state or affect output.
4. **Show the difference, not just the after.** Whenever something changed, draw
   **before** and **after** side by side and make the *delta* visually loud (color +
   line style). The point is the core difference, not a redraw of the end state.
5. **Ground everything to code, adjacent to the claim.** Every box, node, and claim names a real
   symbol + `path:line` and, when possible, is a clickable link back to the source
   (GitHub blob URL or local file). Put the evidence beside the sentence, table row,
   or figure it supports rather than burying sources at the end.
6. **Hand-draw the important diagrams.** For the diagrams that carry the argument,
   prefer **bespoke inline SVG** — you control layout, and before/after stays aligned
   and legible. Mermaid is fine for quick/auxiliary graphs, but auto-layout fights you
   on careful comparisons.
7. **Self-contained & offline.** One HTML file. No build. Inline CSS/SVG; CDN only if
   unavoidable. It must open by double-click and survive being copied to another machine.
8. **Editorial, not dashboard.** Calm document aesthetic (see craft ref): readable
   width, numbered sticky table of contents, claim-carrying section titles, callouts —
   a thing a person can skim or read top to bottom, not a wall of widgets.
9. **Hand back a clickable link.** People look from a different machine. **SmolPaws
   delivery:** publish the page to the `enyst.github.io` GitHub Pages site and hand back the
   clean `https://enyst.github.io/<path>` URL — Pages serves it with the right content-type,
   so it renders directly. See the "HTML artifact delivery" convention in the repo `AGENTS.md`
   (this is how we deliver — disregard the `htmlpreview` guidance in the craft ref).

## Anti-patterns

- ❌ Dumping the raw diff / file tree and calling it "visualized" — adds nothing over the host.
- ❌ Empty nodes ("process data", "handle request") — every node is a real symbol + location.
- ❌ Only the after-state when something changed — the user wants the *contrast*.
- ❌ A build step, a framework, or a dozen CDN scripts — keep it one openable file.
- ❌ Pretty but ungrounded — if a box doesn't map to code, cut it or label it as a concept.
- ❌ Evidence at the end — the reader should not hunt for the file, test, or command that
  makes a claim believable.
- ❌ Process-first narration ("I inspected... then...") — useful work notes are not the
  same as a useful explanation.
