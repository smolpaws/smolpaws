---
name: newsletter
description: Generate a newspaper-style project status dispatch ("The Foreman Dispatch") summarizing active work, agent status, CI/CD state, code reviews, merge queues, documentation health, and open items. Use when the user asks for a project newsletter, status dispatch, daily/weekly digest, standup summary, or newspaper-style report.
triggers:
- /newsletter
- /dispatch
- /digest
license: MIT
metadata:
  tags: reporting, newsletter, status, dispatch, standup
---

# The Foreman Dispatch — Project Status Newsletter

## Objective

Generate a richly formatted, newspaper-style project status report modeled after a broadsheet front page. The dispatch consolidates all active work streams, agent activity, CI/CD health, code reviews, merge queues, documentation status, and open action items into a single scannable document.

## When to Generate

- **Daily**: When used as a standup replacement or end-of-day summary.
- **Weekly**: When used as a sprint recap or stakeholder update.
- The user may specify cadence; default to a snapshot of current state.

## Data Gathering

Before composing the dispatch, collect the following information. Use available tools (git, gh CLI, file reads, API calls) to gather real data — never fabricate status.

### 1. Active Work Streams
```bash
# Current branch and recent commits
git log --oneline --since="24 hours ago" --all
git branch -a --sort=-committerdate | head -10

# Open PRs
gh pr list --state open --json number,title,headRefName,author,reviewDecision,statusCheckRollup,mergeable,updatedAt

# In-progress issues
gh issue list --state open --json number,title,labels,updatedAt
```

### 2. CI/CD & Check Status
```bash
# Recent workflow runs
gh run list --limit 10 --json name,status,conclusion,headBranch,createdAt,url

# Failed runs detail
gh run list --status failure --limit 5 --json databaseId,name,headBranch,conclusion
```

### 3. Code Reviews
```bash
# PRs awaiting review
gh pr list --state open --json number,title,reviewDecision,reviewRequests,additions,deletions,changedFiles,updatedAt

# Recent review activity
gh api repos/{owner}/{repo}/pulls/comments?sort=created&direction=desc&per_page=10 --jq '.[] | {pr: .pull_request_url, author: .user.login, body: .body[0:80], created: .created_at}'
```

### 4. Merge Queue
```bash
# PRs that are approved, mergeable, and have successful status checks
gh pr list --state open --json number,title,reviewDecision,statusCheckRollup,mergeable | jq '[.[] | select(.reviewDecision == "APPROVED" and .mergeable == "MERGEABLE" and ([.statusCheckRollup[]? | .state // .conclusion] | all(. == "SUCCESS")))]'
```

### 5. Documentation & Staleness
```bash
# Markdown files untouched in 30+ days that may be stale
comm -23 <(find . -name '*.md' -not -path './.git/*' | sort) <(git log --all --diff-filter=AM --since="30 days ago" --name-only --pretty=format: -- '*.md' | sort -u)
```

### 6. Git Worktree / Session Health
```bash
# Active worktrees
git worktree list

# Branches with no commits in 7+ days
git for-each-ref --sort=committerdate --format='%(committerdate:unix) %(committerdate:relative) %(refname:short)' refs/heads/ | awk -v cutoff="$(($(date +%s) - 7*24*60*60))" '$1 <= cutoff { sub($1" ", ""); print }' | head -20
```

## Output Format

Render the dispatch as a structured markdown document using the broadsheet newspaper layout below. Use **section headers styled as newspaper columns**, bold labels, and compact bullet-point summaries.

```markdown
───────────────────────────────────────────────────────────────────────
  VOL. {vol} · NO. {issue}     {DAY_OF_WEEK}, {DATE}     {EDITION_TAG}
                        **The Foreman Dispatch**
              *"All the dispatches fit to execute"* — {Project Name}
───────────────────────────────────────────────────────────────────────
{TICKER_BAR: one-line scrolling summary of top 3 headlines}
───────────────────────────────────────────────────────────────────────

## ACTIVE DISPATCH
**[{STATUS_BADGE}]**
### {Primary headline — most significant active work item}
**By {author/agent} | {timestamp} | Session #{id}**

> {1-2 paragraph narrative summary of the main work in progress,
>  written in third-person newspaper style. Include completion %,
>  key milestones reached, and any blockers or open questions.}

*"{Relevant quote from a commit message, PR description, or plan annotation}"*

**Remaining work:** {Brief description of what's left to do.}

---

## SYSTEM CONDITIONS                    | ## ACTIVE AGENTS
☀ {Health summary}                      | • Agent #1  {branch} — {progress}
Server: {status}. DB: {status}.         | • Agent #2  {branch} — {status}
                                        | • Agent #3  {task}   — {status}
---

## CODE REVIEW
**[{STATUS_BADGE}]**
### {Review headline}
**By {reviewer} | {timestamp}**

{Summary: files examined, annotations made, items remaining, blockers.}

---

## MERGE QUEUE
**[{STATUS_BADGE}]**
### {Branch name} Awaits {Action}
**By {gate/system} | {timestamp}**

{CI status, approval status, any human action required.}

---

                    ┌─────────────────┐
## PLAN ANNOTATIONS │ WORKTREE STATUS │ DOCUMENTATION
**[NEEDS RESPONSE]**│ **[NOMINAL]**   │ **[ADVISORY]**
{Open annotations  │ {Worktree count, │ {Stale pages,
 needing author    │  dormant ones,   │  recommended
 response}         │  health status}  │  refresh runs}
                    └─────────────────┘
---

## EDITOR'S DESK — DISPATCH LOG

**{timestamp}** — *"{Question or comment from the log}"*
**{timestamp}** — {Response or status update.}
{Continue for recent conversation/decision log entries.}

---

## ◆ DISPATCH BOARD ◆

| **WANTED**                | **NOTICES**              | **FOR REVIEW**           |
|---------------------------|--------------------------|--------------------------|
| {Seeking executor/help    | {Advisories, staleness   | {Open annotations,       |
|  for a task. Priority,    |  warnings, refresh       |  review items awaiting   |
|  reward, apply-by.}       |  recommendations.}       |  response.}              |

| **RECOVERY**              | **MERGE QUEUE**          |
|---------------------------|--------------------------|
| {Dormant sessions,        | {Branches awaiting       |
|  suspended worktrees,     |  human approval signal.} |
|  recovery instructions.}  |                          |

───────────────────────────────────────────────────────────────────────
  {FOOTER: Date · Agent IDs · Session count · Version}
───────────────────────────────────────────────────────────────────────
```

## Status Badges

Use these labels contextually:

| Badge | Meaning |
|-------|---------|
| `IN PROGRESS` | Active work, not yet complete |
| `IN REVIEW` | Code review underway |
| `QUEUED` | In merge queue, awaiting action |
| `NEEDS RESPONSE` | Blocking on human input |
| `NOMINAL` | Healthy, no issues |
| `ADVISORY` | Non-critical warning |
| `WANTED — EXECUTOR` | Task seeking an assignee |
| `RECOVERY — DORMANT SESSION` | Suspended session needing recovery |
| `MERGE QUEUE — APPROVAL NEEDED` | Awaiting explicit human merge approval |

## Writing Style

- **Third-person newspaper prose.** Write as a reporter covering the project, not as the agent itself.
- **Headline-first.** Each section leads with a punchy headline summarizing the key fact.
- **Quantify everything.** Include numbers: completion %, file counts, time elapsed, CI pass rates.
- **Quote liberally.** Pull relevant quotes from commit messages, PR descriptions, review comments, or plan annotations and render them in italics.
- **Bylines and timestamps.** Every section has an attribution line with author/agent and UTC timestamp.
- **Ticker bar.** The top ticker summarizes the 3 most important items in ALL CAPS shorthand.
- **Dispatch Board.** The bottom section is a classified-ad style board with categorized action items.

## Volume & Issue Numbering

- Use monotonically increasing numbers. If prior dispatches exist in the conversation or session, increment from the last known issue number.
- If no prior dispatch exists, start at `VOL. I · NO. 1`.

## Adaptation

- **Single-repo projects**: Omit the "Active Agents" panel if there's only one work stream.
- **No CI configured**: Replace CI sections with local test results or build status.
- **No PRs open**: Replace Code Review and Merge Queue with recent commit activity summary.
- **Monorepo**: Add a "Package/Workspace Status" sub-section under System Conditions.
- **OpenHands sessions**: Include session IDs and sandbox status in System Conditions.

## Example Invocation

```
User: /newsletter
Agent: [Gathers data from git, gh, filesystem] → Renders The Foreman Dispatch
```

```
User: Give me a weekly dispatch for the last sprint
Agent: [Gathers data scoped to last 7 days] → Renders The Foreman Dispatch with weekly scope
```

```
User: /digest
Agent: [Gathers data for today] → Renders a concise daily edition
```
