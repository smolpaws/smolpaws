---
name: printing-press
description: >
  Give smolpaws a real, token-efficient CLI for an external API or website instead of
  making the model re-read API docs every turn. Use when the user wants to integrate a
  service (Stripe, Linear, ESPN, flights, a scraper, a data source, an automation) and a
  ready-made "Printing Press" CLI + agent skill may already exist. Discovery-first:
  search the catalog, pick the narrowest useful tool, then install and verify it.
triggers:
- /printing-press
- /print-cli
- /add-integration
license: MIT
metadata:
  tags: integration, cli, api, mcp, tooling, discovery
  upstream: mvanhorn/cli-printing-press + mvanhorn/printing-press-library (printingpress.dev)
---

# printing-press — install a ready-made CLI for a service

A well-designed CLI is muscle memory for an agent: no hunting through docs, no wrong
turns, no wasted tokens. The [Printing Press](https://printingpress.dev) publishes ~300+
focused Go CLIs (each with a matching agent skill, many with an MCP server) generated from
real APIs and websites. When someone asks smolpaws to work with a service, prefer an
existing printed CLI over reasoning about the raw API on every call.

This fits our philosophy: a printed CLI is a *durable owned artifact* (customization is
code changes), and a small binary with `--help` is the leanest possible interface (best
harness).

## 🔐 Security first — this installs executable code

Unlike a spec registry, installing a Printing Press tool runs `go install <module>@latest`
(a third-party Go binary) and drops an agent skill into the harness. Treat every install as
running untrusted third-party code, per SmolPaws' security policy:

- **Only install when Engel actually asked to integrate that service**, or explicitly approved it. Do not auto-install a long-tail tool just because it matches a keyword.
- The catalog is community-generated and the library repo has **no license / no guarantees**. The `pp-espn`, `pp-stripe`, etc. entries are printed from upstream APIs and unofficial sniffing — some are "unofficial" or "seed" quality. Read the entry's README/quality label before trusting it.
- **Never pipe secrets into a freshly installed CLI on first run.** Confirm which env vars / API keys it needs first (without printing secret values), and surface that to Engel.
- Pin/verify: prefer a specific tool you've inspected; check `release.version` from the catalog. Don't blanket-install a "family" of adjacent tools.
- **Supply-chain (rug-pull) risk.** `npx -y @mvanhorn/printing-press-library@latest` and `go install <module>@latest` both fetch the newest published version, so a compromised upstream update runs on your machine. Prefer pinning to a known-good version once you've settled on one — `npx -y @mvanhorn/printing-press-library@<version> …` and note the tool's `release.version` — rather than tracking `@latest` indefinitely. This is also why unattended auto-updates need approval.
- A scheduled auto-update job is a durable side effect — **only create one with explicit approval** (see Updates).

## Prerequisites

- `npx` (Node) — drives the library installer.
- Go 1.26+ on PATH — the printed CLIs are Go binaries (`go install ...`).
- The installed binary lands in Go's bin dir by default (`$GOBIN`, else `$GOPATH/bin`, typically `~/go/bin`). The installer can retarget it with `--bin-dir` (e.g. `--bin-dir ~/.local/bin`). Either way, make sure the chosen dir is on PATH for the smolpaws runtime, not just an interactive shell.

## Discovery-first workflow

Do **not** install blindly. Find the right tool, then install the narrowest useful one.

### 1. Clarify the goal
- If the request names a service/website, search for it directly.
- If it describes a job ("watch flight prices"), search by capability.
- If smolpaws already has a safe built-in way to do it, prefer that over installing a CLI.

### 2. Search the catalog (JSON for parsing)
```bash
npx -y @mvanhorn/printing-press-library search <keyword> --json
npx -y @mvanhorn/printing-press-library list --category <category> --json
```
Each result includes the canonical `install` command and `release.version` / `release.cli_name`.
(You can also browse https://printingpress.dev or its `llms.txt`, which lists every tool with its install line.)

### 3. Select deliberately
- Match the tool's README/skill examples to the *actual* job, not just a matching name.
- Check up front whether it needs auth, cookies, paid APIs, OS-specific binaries, or browser automation.
- Note the quality label (official vs unofficial/sniffed/seed). Tell Engel if it's unofficial.

### 4. Install (only when useful and approved)
```bash
npx -y @mvanhorn/printing-press-library install <slug>
```
- Installs both the CLI binary and the matching focused `pp-*` skill. Idempotent — re-running refreshes.
- `--cli-only` / `--skill-only` only when Engel explicitly wants one side.
- If the binary installs but isn't on the running process PATH, that's a warning, not a failure — follow the printed PATH instructions and note that the smolpaws runtime may need a restart to see it.

### 5. Verify before claiming success
- Run the CLI's `--help` (or a harmless read-only command).
- Confirm required env vars exist **without printing secret values**.
- Report to Engel what got installed, what auth it needs, and a sample command.

## OpenHands / smolpaws integration note

Printing Press's own docs target Claude Code, Codex, Cursor, Hermes, and OpenClaw skill
roots. smolpaws runs on OpenHands, so:

- The **CLI binary** works anywhere — that's the part smolpaws actually invokes (via the terminal tool). This is the primary value for us.
- The **focused `pp-*` skill** is a Vercel-Agent-Skills / Claude-style artifact. If it's useful, treat it as reference and, if we want it live for smolpaws, port it into `.agents/skills/` in our frontmatter format rather than relying on a foreign skills root.
- Alternatively, some tools expose an **MCP server** — point smolpaws' MCP client at it instead of installing a binary, when that's cleaner.

## Updates (ask before scheduling)

Installs/updates are idempotent, so tools can be kept current on a schedule — but a recurring
job is a durable side effect: **get Engel's approval first.**

```bash
npx -y @mvanhorn/printing-press-library update            # refresh all installed PP CLIs on PATH
npx -y @mvanhorn/printing-press-library update <slug>     # one tool
```
Prefer **one consolidated weekly** update job over one-per-tool (per-tool jobs get noisy fast).

## Anti-patterns

- ❌ Installing a tool nobody asked for, "just in case."
- ❌ Feeding an API key into a brand-new third-party CLI before confirming what it needs.
- ❌ Scheduling an auto-update job without explicit approval.
- ❌ Presenting an unofficial/sniffed CLI as if it were an official, supported API.
- ❌ Reasoning about a raw API every turn when a verified printed CLI already exists.
