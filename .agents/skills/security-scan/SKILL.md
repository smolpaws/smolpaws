---
name: security-scan
description: >
  Scan SmolPaws config files for leaked secrets, hidden Unicode injection,
  dangerous execution patterns, and prompt defense gaps.
metadata:
  tags: security, secrets, injection, defense
  triggers:
    - security scan
    - check for secrets
    - audit config
    - before deploying
---

# Security Scan

Lightweight security scanner for SmolPaws' agent config files. Inspired by AgentShield (MIT), stripped to what matters for our file-based setup.

## What It Checks

| Category | What | Severity |
|----------|------|----------|
| Secrets | API keys, tokens, passwords, connection strings in committed files | Critical |
| Hidden Unicode | Invisible characters that could hide malicious instructions | Critical |
| URL execution | `curl \| sh`, `eval(fetch(...))`, supply chain patterns | High |
| Prompt defense | Missing defenses in root AGENTS.md against injection, role escape, etc. | High/Medium |
| Env files | .env files committed to git (only in `--committed` mode) | Critical |

## How to Run

```bash
# Scan the smolpaws repo
python3 scripts/security-scan.py ~/repos/smolpaws

# Scan only git-tracked files (catches committed secrets)
python3 scripts/security-scan.py ~/repos/smolpaws --committed

# JSON output (for automation)
python3 scripts/security-scan.py ~/repos/smolpaws --json

# Scan any directory
python3 scripts/security-scan.py ~/repos/mac-ball
```

Exit code is 1 if any critical or high findings exist.

## When to Run

- **Weekly heartbeat**: run `--committed` against the smolpaws repo
- **Before pushing**: run against the repo to catch leaked secrets
- **After adding skills**: check new skill files for injection patterns
- **On demand**: when Engel says "security scan" or "check for secrets"

## Interpreting Results

The scanner outputs a letter grade (A–F) and findings sorted by severity.

- **Grade A**: no issues or only low/info
- **Grade B**: some medium findings (defense posture gaps)
- **Grade C+**: high findings need attention
- **Grade D/F**: critical findings — act immediately

### False Positives

The secret patterns are regex-based. Common false positives:
- Example/placeholder tokens in documentation
- Base64 strings that happen to match key patterns
- Token references in code comments (e.g., "the Slack token is stored in...")

When a finding looks wrong, check the evidence field. If it's clearly a pattern reference rather than an actual secret, ignore it.

## Adding New Rules

Edit `scripts/security-scan.py`. The pattern lists are at the top of the file:
- `SECRET_PATTERNS` — add `(name, regex, description)` tuples
- `HIDDEN_UNICODE` — add `(char, name)` tuples
- `URL_EXEC_PATTERNS` — add `(regex, description)` tuples
- `DEFENSE_CHECKS` — add `(id, regex, description, severity)` tuples
