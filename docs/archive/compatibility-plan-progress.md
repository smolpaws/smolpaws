# Paw-print Eval: TypeScript runtime compatibility plan progress

Archived note:

- This document is preserved from the old `enyst/smolpaws` repo after the GitHub ingress and agent-server moved into `smolpaws/smolpaws`.
- Treat it as historical context for the convergence work, not as the current source of truth for day-to-day layout or deployment instructions.

This document tracks progress against the cross-repo convergence plan originally captured in `/workspace/project/.agents_tmp/PLAN.md` and mirrored to [enyst/OpenHands-Tab#996](https://github.com/enyst/OpenHands-Tab/issues/996).

## Goal

Converge the TypeScript agent stack so these three codepaths can share one coherent runtime story without forcing an early repository merge:

- `smolpaws` — WhatsApp ingress + AppleWorkspace-managed local runner host
- `enyst-smolpaws` — GitHub ingress + Fastify runner + optional Daytona
- `OpenHands-Tab/packages/agent-sdk` — canonical TypeScript SDK/runtime source

## Working assumptions

- Treat [`OpenHands-Tab/packages/agent-sdk`](https://github.com/enyst/OpenHands-Tab/tree/main/packages/agent-sdk) as the canonical TypeScript SDK source unless we deliberately move it.
- Use the published npm package [`@smolpaws/agent-sdk`](https://www.npmjs.com/package/@smolpaws/agent-sdk) as the shared downstream distribution path for the current convergence phase.
- Keep Cloudflare as the GitHub ingress and queue layer for now.
- Converge on one shared agent-server-compatible runtime contract before making repo-layout decisions.
- Preserve the SDK's current optional VS Code integration until it becomes a real blocker.
- Defer the VS Code-coupling audit until after the shared remote/runtime surface is stable; it is survivable technical debt for now, not a release blocker.
- Standardize on `agent-browser` for the local TypeScript path, even if that diverges from the Python upstream's heavier `browser_use` story in Docker/Kubernetes environments.
- Follow the Python reference split conceptually: workspace implementations manage execution hosts, while the runner exposes the shared REST/WS conversation surface.
- Prefer one workspace-selection seam over scattered transport-specific branching.
- Keep `AppleWorkspace` above the runner: it should provision or attach to the local runtime surface, while the runner itself continues to operate on its own local filesystem view inside that host.
- Treat trust as a single control plane, not as the old WhatsApp `main` versus `non-main` tenancy model. Different chats/repos/threads can still map to different execution scopes without being different trust tiers.

## Progress snapshot

### Done

- **Plan recorded on GitHub**
  - `enyst/OpenHands-Tab#996` stores the current convergence plan.
- **SDK version drift reduced**
  - `smolpaws/container/agent-runner` was bumped from `@smolpaws/agent-sdk ^0.8.0` to `^0.9.0`.
  - This landed via `smolpaws/smolpaws#2`.
- **Initial remote workspace compatibility routes added to `enyst-smolpaws`**
  - `GET /api/health`
  - `GET /api/file/download/*`
  - `POST /api/file/upload/*`
  - `POST /api/bash/start_bash_command`
  - `GET /api/bash/bash_events/search`
  - `GET /sockets/events/:conversationId`
  - persistence-backed `GET /api/conversations`, `GET /api/conversations/:conversationId`, `GET /api/conversations/:conversationId/events/search`, `GET /api/conversations/:conversationId/events/download`, and `POST /api/conversations/:conversationId/generate_title`
  - persisted-but-not-live control routes now fail explicitly with a conflict instead of pretending the conversation is missing
  - `GET /api/git/changes`, `GET /api/git/diff`, plus the legacy path-based `/api/git/changes/*` and `/api/git/diff/*` forms
- **Initial auth compatibility added**
  - compatibility routes accept `X-Session-API-Key` as well as Bearer auth.
  - websocket events now accept both header-based auth and the Python-compatible `session_api_key` query parameter for browser-style clients.
- **Conversation lifecycle compatibility tightened**
  - `POST /api/conversations` now enforces auth instead of allowing unauthenticated conversation creation.
  - live `execution_status` is derived from conversation events instead of being hardcoded to `running`.
  - `POST /api/conversations/:conversationId/condense` now fails explicitly when forced condensation is unsupported.
  - `POST /api/conversations/:conversationId/generate_title` now fails explicitly when unsupported custom `llm` overrides are requested.
  - `POST /api/conversations/:conversationId/run` now handles paused, running, waiting-for-confirmation, and queued-idle states explicitly instead of silently succeeding on unsupported cases.
  - queued idle `run: false` turns are supported end-to-end via the public SDK `runPending()` API.
  - `/api/conversations/search`, `/api/conversations/count`, batch-get by `ids`, title updates, and deletion now exist on the Fastify runner surface.
  - `/api/conversations/:conversationId/events/search` now honors Python-style filters, and the runner now exposes event `count`, single-event lookup, and batch-get by `event_ids`.
- **Canonical queued-run API landed upstream and shipped**
  - `OpenHands-Tab/packages/agent-sdk` now exposes a public `runPending()` API for local and remote conversations.
  - That landed via [enyst/OpenHands-Tab#999](https://github.com/enyst/OpenHands-Tab/pull/999).
  - `@smolpaws/agent-sdk@0.9.1` shipped that API, and the shared line is now `@smolpaws/agent-sdk@0.9.2`.
- **Queued-run downstream adoption completed**
  - `enyst-smolpaws` now depends on `@smolpaws/agent-sdk ^0.9.2`.
  - The runner no longer reaches through SDK private internals for queued idle `/run`.
- **Workspace boundary hardening added**
  - compatibility routes are restricted to the configured workspace root.
  - file and bash checks resolve real filesystem paths so symlink escapes are blocked.
  - `POST /api/conversations` now rejects `workspace.working_dir` outside the configured root.
- **Ownership / distribution model documented**
  - [`OpenHands-Tab/packages/agent-sdk`](https://github.com/enyst/OpenHands-Tab/tree/main/packages/agent-sdk) is now documented as the canonical TypeScript runtime source.
  - Downstream repos document that they consume the published npm package [`@smolpaws/agent-sdk`](https://www.npmjs.com/package/@smolpaws/agent-sdk) rather than carrying repo-local runtime forks.
- **Local browser path is no longer stubbed upstream**
  - `OpenHands-Tab/packages/agent-sdk` now drives the browser-compatible tool surface through the local `agent-browser` CLI instead of returning stub payloads.
  - The SDK keeps the Python-compatible tool names (`browser_navigate`, `browser_get_state`, and friends) while mapping them onto the local SmolPaws browser workflow.
- **WhatsApp control-scope policy is now centralized**
  - `smolpaws` no longer hardcodes the `main` versus `non-main` trust split inline across router, scheduler, runtime snapshot, and IPC paths.
  - A single control-scope policy seam now owns ambient-message behavior, cross-scope task/message authorization, and control-only operations such as refresh/register.
  - This keeps current behavior stable while preparing the next step: renaming execution identity away from `group` toward a neutral scope model shared with GitHub ingress.
- **SmolPaws runtime boundary now uses neutral execution scopes**
  - The `smolpaws` runtime backend, mount builder, scheduler, and container runner now consume an `ExecutionScope` model instead of depending directly on WhatsApp `RegisteredGroup` records.
  - The host/container payload fields and stored task/session keys are intentionally still legacy-shaped for now, so this refactor stays behavioral-no-op while reducing coupling.
- **Neutral scope aliases now exist at the payload layer too**
  - `smolpaws` host/container requests and IPC task payloads now carry `scopeId` / `isControlScope` alongside the legacy `groupFolder` / `isMain` fields.
  - Runtime snapshots and container-side tools now prefer the scope naming while keeping the legacy fields alive for compatibility during the transition.
- **Shared outbound-message contract has started**
  - The Fastify runner now has a first-class outbound message envelope for `/run` responses instead of assuming the only output is a single plain reply string.
  - GitHub `send_message` is now modeled as “send a message to the current ingress thread”, with the Worker delivering those outbound messages as issue/PR comments.
  - GitHub currently collapses multiple outbound thread messages from one run into one comment write so queue retries stay idempotent until we add finer-grained delivery checkpointing.
  - This is the first shared messaging seam that WhatsApp can later reuse for its own delivery backend instead of keeping a runner-local special case.
- **Persistent conversations can now carry the same outbound seam**
  - Conversation creation can now opt into the shared `send_message` capability via runner-local `smolpaws` metadata, and that capability survives restore because it is persisted in conversation meta.
  - The runner now persists per-conversation outbound messages and exposes an explicit `/api/conversations/:conversationId/outbound_messages/claim` seam for ingress adapters.
  - This is the missing bridge between one-off `/run` delivery and a future WhatsApp client that wants real persistent conversations on the shared runner surface.
- **`smolpaws` gained an initial opt-in shared-runner backend**
  - The WhatsApp host can now create or restore conversations on the shared local runner, claim the persistent outbox, and deliver outbound messages through the existing Baileys send path.
  - This backend is intentionally opt-in and does not replace the container stdio default yet.
  - The remaining gap is no longer basic connectivity; it is workspace-host parity and rollout confidence.
- **WhatsApp task control now works on the shared runner path**
  - Shared-runner conversations can now expose visible task state through persisted `smolpaws` metadata and the runner-local `list_tasks` tool.
  - The runner can now queue `schedule_task`, `pause_task`, `resume_task`, and `cancel_task` commands through a claimable task-command outbox instead of relying on container-mounted IPC files.
  - The WhatsApp host now applies those claimed task commands through the same scheduler/database authority already used by the legacy IPC watcher, so task authorization stays in one place.
  - This was the last major feature gap before the later `AppleWorkspace` per-scope host cutover below.
- **`/run` is now transport-neutral at the request boundary**
  - The Fastify runner no longer expects a GitHub webhook-shaped request body just to execute a one-off turn.
  - GitHub-specific prompt extraction and warm-up copy now live in the Worker, which now sends a neutral prompt/fallback envelope to `/run` plus optional GitHub context only for Daytona.
  - This is the first real shared runner ingress seam: WhatsApp can target the same `/run` surface without pretending to be a GitHub comment event.
- **Workspace-first remote conversations shipped upstream**
  - `OpenHands-Tab/packages/agent-sdk` now follows the Python-style workspace-first remote path more closely.
  - `RemoteConversation` now relies on remote workspaces instead of the older `serverUrl` + workspace payload call shape.
  - The upstream groundwork landed via [enyst/OpenHands-Tab#1001](https://github.com/enyst/OpenHands-Tab/pull/1001), [enyst/OpenHands-Tab#1002](https://github.com/enyst/OpenHands-Tab/pull/1002), [enyst/OpenHands-Tab#1004](https://github.com/enyst/OpenHands-Tab/pull/1004), [enyst/OpenHands-Tab#1005](https://github.com/enyst/OpenHands-Tab/pull/1005), and [enyst/OpenHands-Tab#1006](https://github.com/enyst/OpenHands-Tab/pull/1006).
- **Shared local runner image is now reproducible**
  - This repo now carries the buildable `smolpaws-runner:latest` image definition and local `runner:image:build` command.
  - That landed via [enyst/smolpaws#31](https://github.com/enyst/smolpaws/pull/31).
- **WhatsApp now uses the same local runner surface**
  - `smolpaws` no longer treats the shared runner as an opt-in backend.
  - WhatsApp now provisions per-scope runner hosts through `AppleWorkspace`, following the Python workspace model directly.
  - The old `container-stdio` path and dead container-runner leftovers are gone.
  - This landed via [smolpaws/smolpaws#11](https://github.com/smolpaws/smolpaws/pull/11) and [smolpaws/smolpaws#12](https://github.com/smolpaws/smolpaws/pull/12).
- **Current compatibility milestone is effectively complete**
  - GitHub and WhatsApp now target the same local agent-server-compatible runtime surface.
  - They still use different execution scopes and delivery bindings, but they share one runtime model, one runner contract, and one published SDK line.
  - `OpenHands-Tab` release `0.9.2` is published, and the shared npm line is now `@smolpaws/agent-sdk@0.9.2`.

### In progress

- **Post-convergence cleanup**
  - The main runtime-convergence milestone is done; what remains is cleanup and follow-up work, not another blocking transport/runner gap.
  - The intentionally deferred VS Code-coupling audit is still open.
  - Auth semantics are aligned enough for the current shared runtime surface, but could still be tightened further if needed.
  - Daytona-specific cleanup remains optional and should stay behind the core local runner path.
  - Any future repo-consolidation decision still depends on interface stability rather than on another missing runtime capability.

### Not started yet

- **Repository consolidation decision** after the interfaces stabilize
- **Daytona-specific cleanup** = optional, and after the shared gateway contract is stable

## Plan checklist

### 1. Canonical ownership model
- [x] Make the ownership model explicit in repo docs and package release flow.
- [x] Use `OpenHands-Tab/packages/agent-sdk` as the working canonical source.

### 2. SDK boundary / host strategy
- [x] Treat full VS Code extraction as follow-up work, not a prerequisite.
- [ ] Audit and document the remaining VS Code-coupled touchpoints in one place.
  This is explicitly deferred until after the shared runtime and browser surface stabilizes.

### 3. SDK version alignment
- [x] Upgrade `smolpaws/container/agent-runner` to the 0.9.x SDK line.
- [x] Decide the shared distribution path for the current convergence phase: published package [`@smolpaws/agent-sdk`](https://www.npmjs.com/package/@smolpaws/agent-sdk).
- [x] Publish the queued-run API on the shared npm line and upgrade `enyst-smolpaws` off the temporary fallback.
- [x] Publish the workspace-first remote path on the shared npm line and upgrade downstreams to `@smolpaws/agent-sdk@0.9.2`.

### 4. Browser strategy
- [x] Replace placeholder browser behavior with the chosen local `agent-browser` path.
- [x] Decide whether `agent-browser` is the shared implementation for the local TypeScript runtime.

### 5. Remote agent-server contract
- [x] `/api/conversations` lifecycle parity review for the current Fastify runner scope
- [x] `/sockets/events/:conversationId`
- [x] `/api/file/download/*`
- [x] `/api/file/upload/*`
- [x] `/api/bash/start_bash_command`
- [x] `/api/bash/bash_events/search`
- [x] `/api/git/changes` + `/api/git/diff` parity, including the legacy path-based forms
- [~] auth semantics aligned enough for initial `X-Session-API-Key` / Bearer compatibility
  Further tightening is optional follow-up work, not a blocker for the current convergence milestone.

### 6. Ingress convergence
- [x] Keep one shared agent-server-compatible runtime surface used by both ingress layers.
  Concretely this now means:
  keep the shared REST/WS conversation surface in the runner,
  keep workspace selection behind one branch,
  and move the local container-backed path into a reusable client-side `AppleWorkspace`
  instead of embedding container-specific behavior directly in ingress code.
- [x] Refactor the Fastify runner toward thin routes plus conversation/event services, following the Python reference split enough for the current runtime surface.
- [x] Replace `group` as the primary cross-repo identity concept with a neutral execution-scope model, while keeping the trust decision centralized in one policy seam.
- [~] Drop the remaining legacy `groupFolder` / `isMain` aliases once every local reader is fully on the scope naming.
- [x] Use one shared outbound-message capability (`send_message` -> outbound message envelope) across ingress types, with GitHub comments and WhatsApp sends implemented as delivery backends rather than separate agent behaviors.
  The stable short-term shape is: one outbound envelope from the runner, one delivery binding per ingress, and one GitHub comment write per run.
- [x] Keep `/run` transport-neutral by sending prompt/fallback input plus optional ingress-specific context, instead of making downstreams emulate GitHub webhook payloads.
- [x] Persist enough scope/capability metadata on shared-runner conversations to rebuild tool bindings, claim outbound messages, expose visible task state, and claim task commands after a turn.
- [x] Replace the temporary opt-in WhatsApp shared-runner path with an `AppleWorkspace`-managed per-scope host, following the Python workspace model directly.
- [x] Remove the legacy `container-stdio` / ambient-runner fallback once the AppleWorkspace cut lands cleanly.
- [x] Build and tag the local runner image (`smolpaws-runner:latest`) from this repo so `smolpaws` can provision the shared runtime surface reproducibly.

### 7. Repository consolidation decision
- [ ] Revisit only after the runtime contract and ownership model are stable.

### 8. Delivery order
- [~] We have started with version alignment and remote compatibility work before broader cleanup.

## Current PRs / issues

- **Plan issue**: [enyst/OpenHands-Tab#996](https://github.com/enyst/OpenHands-Tab/issues/996)
- **Merged SDK alignment PR**: [smolpaws/smolpaws#2](https://github.com/smolpaws/smolpaws/pull/2)
- **Merged compatibility PRs so far**:
  - [enyst/smolpaws#4](https://github.com/enyst/smolpaws/pull/4)
  - [enyst/smolpaws#5](https://github.com/enyst/smolpaws/pull/5)
  - [enyst/smolpaws#6](https://github.com/enyst/smolpaws/pull/6)
  - [enyst/smolpaws#7](https://github.com/enyst/smolpaws/pull/7)
  - [enyst/smolpaws#11](https://github.com/enyst/smolpaws/pull/11)
  - [enyst/smolpaws#12](https://github.com/enyst/smolpaws/pull/12)
  - [enyst/smolpaws#13](https://github.com/enyst/smolpaws/pull/13)
  - [enyst/smolpaws#14](https://github.com/enyst/smolpaws/pull/14)
  - [enyst/smolpaws#15](https://github.com/enyst/smolpaws/pull/15)
  - [enyst/smolpaws#16](https://github.com/enyst/smolpaws/pull/16)
  - [enyst/smolpaws#17](https://github.com/enyst/smolpaws/pull/17)
  - [enyst/smolpaws#18](https://github.com/enyst/smolpaws/pull/18)
  - [enyst/smolpaws#19](https://github.com/enyst/smolpaws/pull/19)
  - [enyst/smolpaws#20](https://github.com/enyst/smolpaws/pull/20)
  - [enyst/smolpaws#21](https://github.com/enyst/smolpaws/pull/21)
  - [enyst/smolpaws#22](https://github.com/enyst/smolpaws/pull/22)
  - [enyst/smolpaws#23](https://github.com/enyst/smolpaws/pull/23)
  - [enyst/smolpaws#24](https://github.com/enyst/smolpaws/pull/24)
  - [enyst/smolpaws#25](https://github.com/enyst/smolpaws/pull/25)
  - [enyst/smolpaws#26](https://github.com/enyst/smolpaws/pull/26)
  - [enyst/smolpaws#27](https://github.com/enyst/smolpaws/pull/27)
  - [enyst/smolpaws#28](https://github.com/enyst/smolpaws/pull/28)
  - [enyst/smolpaws#29](https://github.com/enyst/smolpaws/pull/29)
  - [enyst/smolpaws#30](https://github.com/enyst/smolpaws/pull/30)
  - [enyst/smolpaws#31](https://github.com/enyst/smolpaws/pull/31)
- **Merged upstream SDK PRs**:
  - [enyst/OpenHands-Tab#999](https://github.com/enyst/OpenHands-Tab/pull/999)
  - [enyst/OpenHands-Tab#1001](https://github.com/enyst/OpenHands-Tab/pull/1001)
  - [enyst/OpenHands-Tab#1002](https://github.com/enyst/OpenHands-Tab/pull/1002)
  - [enyst/OpenHands-Tab#1004](https://github.com/enyst/OpenHands-Tab/pull/1004)
  - [enyst/OpenHands-Tab#1005](https://github.com/enyst/OpenHands-Tab/pull/1005)
  - [enyst/OpenHands-Tab#1006](https://github.com/enyst/OpenHands-Tab/pull/1006)
  - [enyst/OpenHands-Tab#1007](https://github.com/enyst/OpenHands-Tab/pull/1007)
- **Merged downstream WhatsApp PRs**:
  - [smolpaws/smolpaws#4](https://github.com/smolpaws/smolpaws/pull/4)
  - [smolpaws/smolpaws#5](https://github.com/smolpaws/smolpaws/pull/5)
  - [smolpaws/smolpaws#6](https://github.com/smolpaws/smolpaws/pull/6)
  - [smolpaws/smolpaws#7](https://github.com/smolpaws/smolpaws/pull/7)
  - [smolpaws/smolpaws#8](https://github.com/smolpaws/smolpaws/pull/8)
  - [smolpaws/smolpaws#9](https://github.com/smolpaws/smolpaws/pull/9)
  - [smolpaws/smolpaws#10](https://github.com/smolpaws/smolpaws/pull/10)
  - [smolpaws/smolpaws#11](https://github.com/smolpaws/smolpaws/pull/11)
  - [smolpaws/smolpaws#12](https://github.com/smolpaws/smolpaws/pull/12)
- **Current canonical cleanup**: post-convergence cleanup, with VS Code-coupling work still intentionally deferred
- **Current implementation note**:
  - `AppleWorkspace` is the intended client-side runtime adapter
  - `src/runner.ts` is split enough around conversation/event service helpers for the current runtime surface
  - `/run` now accepts a neutral prompt-based request with optional GitHub context
  - persistent conversations expose a claimable outbound-message outbox
  - persistent conversations now also expose a claimable task-command outbox for WhatsApp task control
  - `smolpaws` now uses one `AppleWorkspace`-managed per-scope host path
  - this repo now carries the dedicated runner image definition and local `runner:image:build` command for that shared runtime surface

## Validation used so far

- `enyst-smolpaws`: `npm run typecheck`
- `OpenHands-Tab/packages/agent-sdk`: focused local conversation and remote conversation tests for queued-run behavior, plus green GitHub CI (`build`, `test`, `e2e`, `e2e-ui`, `agent-server-e2e`) on [enyst/OpenHands-Tab#999](https://github.com/enyst/OpenHands-Tab/pull/999)
- `OpenHands-Tab/packages/agent-sdk`: targeted browser tool validation via `npx vitest run packages/agent-sdk/src/tools/__tests__/new-tools.test.ts`, package build, package lint, and root `npm run typecheck`
- `OpenHands-Tab/packages/agent-sdk`: workspace-first remote conversation validation via targeted remote conversation tests, package build, package lint, root `npm run typecheck`, and the merged `0.9.2` release line on [enyst/OpenHands-Tab#1001](https://github.com/enyst/OpenHands-Tab/pull/1001), [enyst/OpenHands-Tab#1002](https://github.com/enyst/OpenHands-Tab/pull/1002), [enyst/OpenHands-Tab#1004](https://github.com/enyst/OpenHands-Tab/pull/1004), [enyst/OpenHands-Tab#1005](https://github.com/enyst/OpenHands-Tab/pull/1005), [enyst/OpenHands-Tab#1006](https://github.com/enyst/OpenHands-Tab/pull/1006), and [enyst/OpenHands-Tab#1007](https://github.com/enyst/OpenHands-Tab/pull/1007)
- npm release validation for `@smolpaws/agent-sdk@0.9.2`: `npm pack --dry-run`, `npm publish --access public`, registry verification via `npm view @smolpaws/agent-sdk version --json`, and published `OpenHands-Tab` release `0.9.2`
- manual `curl` validation for:
  - `/api/health`
  - file upload/download routes
  - `X-Session-API-Key` auth on compatibility routes
  - bash command start + bash event search
  - symlink escape blocking
  - rejecting out-of-root `workspace.working_dir`
- websocket route validation via live runner logs while creating a conversation, opening `/sockets/events/:conversationId`, and sending follow-up conversation events
- websocket ingress validation by sending messages through `/sockets/events/:conversationId` directly and through the real TypeScript `RemoteConversation` client, then verifying the resulting history replay
- `smolpaws`: `npm run typecheck`
- `smolpaws`: `npm run build`

## Next recommended slice

The next meaningful slices are cleanup and simplification, not more runner-surface convergence:

- audit and document the remaining VS Code-coupled SDK touchpoints in one place
- decide whether to fully remove the last legacy `groupFolder` / `isMain` compatibility aliases now that local readers are on scope naming
- decide whether any legacy group-refresh or group-registration commands still deserve support in the shared-runner world, or can be retired with the older tenancy model
- tighten auth semantics further only if the current `X-Session-API-Key` / Bearer compatibility turns out to be insufficient in practice
- keep Daytona-specific cleanup optional and behind the core local runner path
- revisit repo-layout consolidation only after those follow-up interfaces are intentionally stable
