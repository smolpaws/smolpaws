---
name: executor-qa-demo
description: >
  Run the autonomous-QA loop Rhys Sullivan asked for against
  RhysSullivan/executor: use real dev tools (browser + terminal) to develop or
  fix a real change, then crystallize that same session into a black-box e2e
  scenario plus a watchable video, and deliver it as one lean PR on his repo.
  Use when building a demo/PR for executor, answering Rhys's "autonomous QA
  agent" ask, or learning executor's e2e harness machinery.
metadata:
  tags: executor, e2e, qa, demo, playwright, video, rhys
  triggers:
    - executor qa demo
    - autonomous qa agent
    - executor e2e
    - PR to rhys
    - rhys sullivan demo
---

# Executor Autonomous-QA Demo

## Why this exists

Rhys Sullivan ([@RhysSullivan](https://x.com/RhysSullivan/status/2069637281963708459))
publicly asked for an "OpenDevin in the autonomous QA sense": an agent that gets
**real developer tools** (chrome, a terminal), uses them to **develop/exercise
the product**, and then **turns that session into e2e tests in the repo**, open
source, local, multi-target, with **video output** you can play back. His bar:
*"verify an agent's work without running anything locally, purely by looking at
the e2e test and test output."* He said if you've built it, "have your agent
open a PR to my repo with your product."

He already built the harness (`RhysSullivan/executor/e2e`). What he wants shown
is the **agent that drives it**.

### The core requirement (don't miss it)

The novel thing he asked for is **req 2: develop with the tools, THEN emit the
test from that session**, not "add test coverage to something already built."
A PR that only adds scenarios proves test-authoring; it does NOT prove the
develop→crystallize loop. The winning demo must:

1. Use the browser + terminal to **reach a real product state** (reproduce a
   bug, build a small feature, exercise a flow).
2. **Crystallize that exact journey** into a `scenario()` in the repo's shape.
3. Produce a **watchable video** of it.
4. Land as a lean PR on **`RhysSullivan/executor`** that a reviewer can judge by
   reading the test + watching the output, nothing run locally.

## Background: the failed first attempt (learn from it)

A prior agent opened `rajshah4/executor#1` (a fork, not Rhys's repo, he never
saw it; now CLOSED). It added two policies scenarios. What went wrong, per our
review and the author's own admission:

- **Only added coverage**, never developed anything, so it skipped req 2.
- **Leaked the private chat** into a public PR ("wire this into a hosted
  product", "for monetization…"), pure marketing bleed. The author agreed.
- **Used em-dashes** (as `&mdash;`), executor's root `AGENTS.md` bans the `—`
  character anywhere, including escaped.
- **Fretted about tokens** in the PR body instead of just shipping a great
  video.

The one genuinely useful nugget: executor's harness produces video via
`E2E_FILM=1`, which OpenHands' own Verifier does **not** do by default. That
capability is the thing to lift and show off.

Do not repeat these mistakes.

## Executor's machinery (the ground truth)

Always re-verify against the code; this is a starting map (executor moves fast).

### Layout
- `e2e/AGENTS.md`: how to write a scenario (the style contract). READ FIRST.
- `RUNNING.md`: how things run (bootstrap, ports, viewer, sharing). READ SECOND.
- Root `AGENTS.md`: engineering + attribution + **no-em-dash** rules.
- `e2e/scenarios/*.test.ts`: cross-target scenarios (cloud + selfhost).
- `e2e/cloud/*`, `e2e/selfhost/*`: target-specific.
- `e2e/src/scenario.ts`: the `scenario()` entry; `e2e/src/services.ts`: the
  services a body can yield (`Api`, `Browser`, `Mcp`, `Target`, …).
- `e2e/src/surfaces/browser.ts`: Playwright session, video/trace, watchable
  slow-mo. `e2e/src/timeline.ts`: film "beats".
- `e2e/targets/*.ts`: target capability sets (verify which declare `browser`).
- `packages/core/api/src/<group>/api.ts`: typed API shapes (READ ONLY).
- `packages/react/src/pages/<page>.tsx`: route components for browser pins.

### The develop→crystallize tool (the heart of req 2)
`cd e2e && bun run cli`, the same primitives scenarios use, as live commands:
```sh
bun run cli up selfhost --share   # boot a real instance, reachable, stays up
bun run cli status                # URLs, creds
bun run cli identity selfhost     # fresh identity (headers/cookies/creds)
bun run cli api selfhost tools.list
bun run cli mcp selfhost call execute '{"code":"return 1+1;"}'
bun run cli ledger cloud workos   # what hit the emulator
bun run cli down selfhost         # clean teardown
```
This is the literal "develop interactively, then crystallize the journey into a
scenario" surface. Drive the product with it (and a real browser), confirm the
behavior, THEN write the scenario that pins what you just did.

### Run + watchable video
```sh
cd e2e
bun run bootstrap                                   # idempotent: install + Playwright
bun run test:cloud scenarios/<file>.test.ts         # fast verify (no film)
bun run test:selfhost scenarios/<file>.test.ts
E2E_FILM=1 bun run test:cloud scenarios/<file>.test.ts   # watchable: 400ms slow-mo + beats
```
Artifacts land in `e2e/runs/<target>/<slug>/`: `result.json`, step screenshots,
`session.mp4`, `trace.zip`, and the scenario source as `test.ts`.

`bun e2e/scripts/pr-media.ts e2e/runs/<target>/<slug>` converts the recording to
a gif, uploads to the `e2e-media` branch, and prints PR-ready markdown. Prefer
this over hand-hosting a release asset.

### Gates (run all before pushing)
```sh
bunx oxfmt --check e2e/scenarios/<file>.test.ts
bunx oxlint -c .oxlintrc.jsonc e2e/scenarios/<file>.test.ts --deny-warnings
cd e2e && bun run typecheck
```

## The style contract (from e2e/AGENTS.md, non-negotiable)

- **Black-box only.** Drive via public surfaces (typed API, web UI, MCP, CLI).
  Never import app internals, never touch the DB, never modify product code. If
  the product blocks you, STOP and report, do not work around it.
- **The test source is the review artifact.** It must read top-to-bottom as a
  spec. The name is a product guarantee ("Policies · an existing policy can be
  re-targeted and removed"), not a test id.
- **Assert on values, not booleans.** `expect(list).toContain(x)`, never
  `expect(list.includes(x)).toBe(true)`. No `.isVisible().toBe(true)`.
- **Clean up with `Effect.ensuring`**, not trailing statements, a mid-test
  failure must not leak state. Put post-create assertions inside the finalizer
  with a captured id holder (see `metadata-editing.test.ts`).
- **Isolation:** cloud `newIdentity()` is a fresh user+org. Selfhost is shared
  bootstrap-admin, prefix every created resource with your scenario slug and
  assert "contains mine", never global counts.
- **Locators:** prefer role-based; scope by `data-slot` over bare text.
- **Deterministic:** no sleeps; wait on conditions.

## Executor's repo rules (from root AGENTS.md, will fail review if broken)

- **No em-dashes anywhere**, not in prose, code, commits, or PRs, and not as
  `&mdash;`/`&#8212;` either. Use commas, colons, parentheses, or two sentences.
- **No AI attribution / Co-Authored-By trailers** on commits, messages, PRs, or
  generated files.
- **PR titles/descriptions are public**, no specific names, no internal info,
  **no private conversation content**, no marketing/monetization talk. Evidence
  only.
- Code is cheap; don't give time/token estimates.

## The loop (run it end to end)

1. **Update the repo.** `~/repos/executor` exists; it may be force-pushed
   upstream. `git fetch origin && git reset --hard origin/main` (verify clean
   first). Confirm latest `main`.
2. **Read the contract.** `e2e/AGENTS.md`, `RUNNING.md`, root `AGENTS.md`, then
   3-5 existing scenarios spanning the surfaces you'll use (API, API+browser,
   MCP). Goal: write in the exact shape without looking back.
3. **Pick a real change, not just a gap.** For req 2, choose an open issue that
   forces tool use: reproduce in-browser/API, develop the fix or feature, verify
   live. Good first targets are small, fully black-box, dramatic on video (e.g.
   a UI behavior bug). Check `gh issue list --repo RhysSullivan/executor`.
4. **Develop with the tools.** Boot via `bun run cli up <target> --share`, drive
   the product (browser + API/MCP), reach the real state. This session IS the
   demo.
5. **Crystallize.** Write the `scenario()` that pins exactly what you did. Spec-
   shaped name, value assertions, `Effect.ensuring` cleanup, scoped locators.
6. **Verify on every target.** Fast run on cloud + selfhost; fix until green.
   Run the gates (oxfmt, oxlint, typecheck).
7. **Film it.** `E2E_FILM=1` re-run for the watchable pace; `pr-media.ts` for
   PR-ready media.
8. **Self-review loop (optional but strong).** Spawn an independent reviewer
   subagent (no author context) to critique the diff against the style guide,
   apply findings, then a verifier subagent to re-run and capture evidence.
   Subagent model per repo/CLAUDE rules. Keep the verdicts factual.
9. **Open ONE lean PR on `RhysSullivan/executor`.** Body = what it adds + the
   embedded video/gif + verification commands and results. No marketing, no
   names, no em-dashes, no chat leakage. Author from a clearly-automated
   identity if you want the "bot opened this" framing.
10. **One honest sentence on scope.** Name what the demo proves and what's next
    (e.g. "this shows the develop→test→video loop on one issue; the same loop
    scales to richer surfaces"). Precise scoping reads as competence to a
    builder like Rhys. Do not overclaim.

## Quality bar

- Did the agent actually **develop with tools**, or just write a test? If the
  latter, it has not met req 2, fix the framing or the work.
- Is the video **watchable** and does it show the journey (not just a green
  check re-run)?
- Could a reviewer judge it **without running anything**, test reads as spec,
  output is attached?
- Is the PR body **evidence-only**, no marketing, no em-dashes, no leaked
  conversation, on **Rhys's repo**?

## Gotchas (verified against executor)

| Symptom | Fix |
|---|---|
| `bun: command not found` | `curl -fsSL https://bun.sh/install \| bash` then `export PATH="$HOME/.bun/bin:$PATH"` in each shell |
| Fresh worktree dies: `Failed to resolve entry for @executor-js/vite-plugin` | run `bun run bootstrap` first (builds the plugin + react) |
| Scratch script can't resolve `effect`/`playwright` | put it under the repo (`scratch/` is gitignored), not `/tmp` |
| selfhost dev server times out on first boot | retry once; port locks make the second attempt clean |
| `SchemaError: Missing key at ["owner"]` on `policies.update` | the update payload requires `owner` even when other fields are optional, read the API schema first |
| `gh pr review --request-changes` fails on your own PR | use `gh pr comment` with the verdict in the body |
| dev server serves pre-rebase code | clear `node_modules/.vite` cache, reboot |
| stale `e2e/AGENTS.md` says "browser cloud-only" | verify `e2e/targets/*.ts` capability sets, selfhost declares `browser` now |

## References

- Rhys's ask: https://x.com/RhysSullivan/status/2069637281963708459
- Repo: https://github.com/RhysSullivan/executor (local: `~/repos/executor`)
- Contracts: `e2e/AGENTS.md`, `RUNNING.md`, root `AGENTS.md`
- First attempt (closed, on a fork): `rajshah4/executor#1`
