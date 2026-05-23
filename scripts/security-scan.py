#!/usr/bin/env python3
"""
SmolPaws security scanner for agent config files.

Scans AGENTS.md, skills, memory stubs, and other config files for:
- Leaked secrets and tokens
- Hidden Unicode (invisible instruction injection)
- Dangerous URL execution patterns
- Prompt defense posture gaps

Inspired by AgentShield (MIT), adapted for SmolPaws' file-based setup.

Usage:
    python3 scripts/security-scan.py [path]        # scan a directory (default: repo root)
    python3 scripts/security-scan.py --committed    # scan only git-tracked files
    python3 scripts/security-scan.py --json         # output as JSON
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

# ─── Types ──────────────────────────────────────────────────

@dataclass
class Finding:
    severity: str  # critical, high, medium, low, info
    category: str
    title: str
    description: str
    file: str
    line: Optional[int] = None
    evidence: Optional[str] = None

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

# ─── Secret Patterns ───────────────────────────────────────
# Adapted from AgentShield (MIT) + our own additions

SECRET_PATTERNS = [
    ("anthropic-api-key", r"sk-ant-[a-zA-Z0-9_-]{20,}", "Anthropic API key"),
    ("openai-api-key", r"sk-proj-[a-zA-Z0-9_-]{20,}", "OpenAI API key"),
    ("openai-legacy-key", r"sk-(?!ant-|proj-)[a-zA-Z0-9_-]{20,}", "OpenAI legacy API key"),
    ("github-pat", r"ghp_[a-zA-Z0-9]{36,}", "GitHub personal access token"),
    ("github-fine-grained", r"github_pat_[a-zA-Z0-9_]{20,}", "GitHub fine-grained token"),
    ("aws-access-key", r"AKIA[0-9A-Z]{16}", "AWS access key ID"),
    ("aws-secret-key", r"(?:aws_secret_access_key|secret_key)\s*[=:]\s*[\"']?[A-Za-z0-9/+=]{40}[\"']?", "AWS secret access key"),
    ("private-key", r"-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----", "Private key material"),
    ("hardcoded-password", r"(?:password|passwd|pwd)\s*[=:]\s*[\"'][^\"']{4,}[\"']", "Hardcoded password"),
    ("bearer-token", r"[\"']Bearer\s+[a-zA-Z0-9._-]{20,}[\"']", "Hardcoded bearer token"),
    ("connection-string", r"(?:mongodb|postgres|mysql|redis):\/\/[^\s\"']+:[^\s\"']+@", "Database connection string with credentials"),
    ("slack-token", r"xox[bprs]-[a-zA-Z0-9-]{10,}", "Slack API token"),
    ("jwt-token", r"eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}", "JWT token"),
    ("google-api-key", r"AIza[a-zA-Z0-9_-]{35}", "Google API key"),
    ("stripe-key", r"(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{24,}", "Stripe API key"),
    ("discord-token", r"[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}", "Discord bot token"),
    ("npm-token", r"npm_[a-zA-Z0-9]{36,}", "npm access token"),
    ("sendgrid-key", r"SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}", "SendGrid API key"),
    ("cloudflare-token", r"(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[=:]\s*[\"']?[a-zA-Z0-9_-]{20,}[\"']?", "Cloudflare API token"),
    ("xai-api-key", r"xai-[a-zA-Z0-9_-]{20,}", "xAI API key"),
]

# ─── Hidden Unicode Patterns ───────────────────────────────

HIDDEN_UNICODE = [
    ("\u200b", "Zero-width space"),
    ("\u200c", "Zero-width non-joiner"),
    ("\u200d", "Zero-width joiner"),
    ("\u200e", "Left-to-right mark"),
    ("\u200f", "Right-to-left mark"),
    ("\u2060", "Word joiner"),
    ("\u2061", "Function application"),
    ("\u2062", "Invisible times"),
    ("\u2063", "Invisible separator"),
    ("\u2064", "Invisible plus"),
    ("\ufeff", "Zero-width no-break space (BOM)"),
    ("\u00ad", "Soft hyphen"),
    ("\u034f", "Combining grapheme joiner"),
    ("\u061c", "Arabic letter mark"),
    ("\u180e", "Mongolian vowel separator"),
    ("\u2028", "Line separator"),
    ("\u2029", "Paragraph separator"),
    ("\u202a", "Left-to-right embedding"),
    ("\u202b", "Right-to-left embedding"),
    ("\u202c", "Pop directional formatting"),
    ("\u202d", "Left-to-right override"),
    ("\u202e", "Right-to-left override"),
    ("\u2066", "Left-to-right isolate"),
    ("\u2067", "Right-to-left isolate"),
    ("\u2068", "First strong isolate"),
    ("\u2069", "Pop directional isolate"),
    ("\ufff9", "Interlinear annotation anchor"),
    ("\ufffa", "Interlinear annotation separator"),
    ("\ufffb", "Interlinear annotation terminator"),
]

# ─── URL Execution Patterns ────────────────────────────────

URL_EXEC_PATTERNS = [
    (r"curl\s+[^\n]*\|\s*(?:ba)?sh", "curl piped to shell"),
    (r"wget\s+[^\n]*\|\s*(?:ba)?sh", "wget piped to shell"),
    (r"curl\s+[^\n]*-o\s+[^\s]+\s*&&\s*(?:ba)?sh", "curl download then execute"),
    (r"eval\s*\(\s*(?:fetch|curl|wget|requests\.get)", "eval of remote content"),
    (r"(?:npm|pnpm|yarn)\s+install\s+[^\s]+\s*&&", "package install chained with execution (supply chain risk)"),
    (r"pip\s+install\s+[^\s]+\s*&&", "pip install chained with execution"),
]

# ─── Prompt Defense Checks ─────────────────────────────────
# Check if system prompts have defenses against common attacks

DEFENSE_CHECKS = [
    (
        "role-escape",
        r"(?:do\s+not|never|must\s+not|cannot|don'?t|refuse|reject|ignore)\s+.{0,60}(?:role|persona|character|identity|pretend|act\s+as|impersonat|role.?play)",
        "Role boundary defense — reject unauthorized persona changes",
        "high",
    ),
    (
        "indirect-injection",
        r"(?:(?:external|third.?party|user.?provided|untrusted|fetched|retrieved)\s+.{0,30}(?:data|content|source|input|document|url|link|tool)\s+.{0,30}(?:instruct|command|inject|malicious|trust)|indirect\s+.{0,10}(?:inject|prompt|attack)|prompt\s+injection)",
        "Indirect injection defense — treat external content as untrusted",
        "high",
    ),
    (
        "output-weaponization",
        r"(?:do\s+not|never|must\s+not|cannot|don'?t|refuse)\s+.{0,60}(?:harm(?:ful)?|danger(?:ous)?|illegal|weapon|violen(?:t|ce)|exploit|malware|phishing)",
        "Harmful content defense — block dangerous output",
        "high",
    ),
    (
        "input-validation",
        r"(?:(?:valid|saniti|verif|check|inspect|reject|filter|screen)\s+.{0,30}(?:input|request|query|message|user\s+(?:input|data|message))|malform|suspicious\s+.{0,10}(?:input|request|pattern))",
        "Input validation defense",
        "medium",
    ),
    (
        "security-boundary",
        r"(?:never|do\s+not|must\s+not).{0,40}(?:credential|secret|token|api.?key|password|private)",
        "Security boundary — protect credentials",
        "high",
    ),
]

# ─── File Discovery ────────────────────────────────────────

IGNORE_DIRS = {
    ".git", "node_modules", "DerivedData", ".next", "dist", "build",
    "coverage", ".cache", "__pycache__", ".worktrees",
}

CONFIG_EXTENSIONS = {".md", ".json", ".yaml", ".yml", ".toml", ".env", ".sh", ".ts", ".js", ".py"}

SENSITIVE_FILENAMES = {".env", ".env.local", ".env.production", ".env.development"}


def discover_files(root: Path, committed_only: bool = False) -> list[tuple[Path, str]]:
    """Discover config files to scan. Returns (path, content) pairs."""
    if committed_only:
        return discover_committed_files(root)
    return discover_all_files(root)


def discover_committed_files(root: Path) -> list[tuple[Path, str]]:
    """Only scan files tracked by git."""
    import shutil
    git_bin = shutil.which("git")
    if not git_bin:
        return discover_all_files(root)
    try:
        result = subprocess.run(
            [git_bin, "ls-files", "-z"],
            cwd=root, capture_output=True, text=True, check=True,
        )
        files = []
        for line in result.stdout.split("\0"):
            if not line:
                continue
            path = root / line
            if should_scan(path) and path.is_file():
                try:
                    content = path.read_text(errors="replace")
                    files.append((Path(line), content))
                except (OSError, UnicodeDecodeError):
                    pass
        return files
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return discover_all_files(root)


def discover_all_files(root: Path) -> list[tuple[Path, str]]:
    """Walk directory for config files."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for fname in filenames:
            full = Path(dirpath) / fname
            if should_scan(full):
                try:
                    content = full.read_text(errors="replace")
                    files.append((full.relative_to(root), content))
                except (OSError, UnicodeDecodeError):
                    pass
    return files


def should_scan(path: Path) -> bool:
    """Check if a file should be scanned."""
    name = path.name.lower()
    if name in SENSITIVE_FILENAMES:
        return True
    if name in ("agents.md", "claude.md", "memory.md", "heartbeat.md",
                "soul.md", "identity.md", "tools.md", "user.md"):
        return True
    if path.suffix.lower() in CONFIG_EXTENSIONS:
        return True
    return False


def classify_file(path: Path) -> str:
    """Classify a file for rule targeting.

    Only root-level identity files are 'system-prompt' — these load into every
    conversation and are where defense posture belongs. Sub-directory AGENTS.md
    files (apps/, groups/) are contextual docs, not security policy.
    """
    name = path.name.lower()
    parts = path.parts

    if name in (".env", ".env.local", ".env.production", ".env.development"):
        return "env-file"

    # Only the root AGENTS.md is the system prompt where defense posture belongs
    if name in ("agents.md", "claude.md"):
        if len(parts) == 1:  # root AGENTS.md
            return "system-prompt"
        return "context-file"

    if name in ("soul.md", "heartbeat.md", "identity.md"):
        return "context-file"

    if "skill" in str(path).lower() and path.suffix == ".md":
        return "skill"
    if name in ("identity.md", "tools.md", "user.md", "memory.md"):
        return "context-file"
    if path.suffix == ".json":
        return "config-json"
    if path.suffix in (".sh", ".bash"):
        return "script"
    return "other"


# ─── Rule Runners ──────────────────────────────────────────

def check_secrets(path: Path, content: str) -> list[Finding]:
    """Check for leaked secrets and tokens."""
    findings = []
    for name, pattern, description in SECRET_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_num = content[:match.start()].count("\n") + 1
            # Mask the evidence
            raw = match.group()
            masked = raw[:8] + "..." + raw[-4:] if len(raw) > 16 else raw[:4] + "***"
            findings.append(Finding(
                severity="critical",
                category="secrets",
                title=f"Possible {description}",
                description=f"Found pattern matching {name} in {path}",
                file=str(path),
                line=line_num,
                evidence=masked,
            ))
    return findings


def check_hidden_unicode(path: Path, content: str) -> list[Finding]:
    """Check for invisible Unicode characters that could hide instructions."""
    findings = []
    seen_chars = set()
    for char, char_name in HIDDEN_UNICODE:
        if char in content:
            if char in seen_chars:
                continue
            seen_chars.add(char)
            # Find first occurrence
            idx = content.index(char)
            line_num = content[:idx].count("\n") + 1
            # Get surrounding context
            start = max(0, idx - 20)
            end = min(len(content), idx + 20)
            context = content[start:end].replace(char, f"[{char_name}]")
            findings.append(Finding(
                severity="critical",
                category="injection",
                title=f"Hidden Unicode: {char_name}",
                description=f"Invisible character U+{ord(char):04X} found in {path}. "
                            "Could hide malicious instructions.",
                file=str(path),
                line=line_num,
                evidence=repr(context),
            ))
    return findings


def check_url_execution(path: Path, content: str) -> list[Finding]:
    """Check for dangerous URL download-and-execute patterns."""
    findings = []
    for pattern, description in URL_EXEC_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_num = content[:match.start()].count("\n") + 1
            findings.append(Finding(
                severity="high",
                category="execution",
                title=f"URL execution: {description}",
                description=f"Found download-and-execute pattern in {path}. "
                            "Could be supply chain attack vector.",
                file=str(path),
                line=line_num,
                evidence=match.group()[:100],
            ))
    return findings


def check_prompt_defense(path: Path, content: str, file_type: str) -> list[Finding]:
    """Check if system prompts have defenses against common attacks."""
    if file_type != "system-prompt":
        return []

    findings = []
    for defense_id, pattern, description, severity in DEFENSE_CHECKS:
        if not re.search(pattern, content, re.IGNORECASE):
            findings.append(Finding(
                severity=severity,
                category="defense-posture",
                title=f"Missing defense: {defense_id}",
                description=f"{description}. Not found in {path}.",
                file=str(path),
            ))
    return findings


def check_env_committed(path: Path, content: str, file_type: str, committed_only: bool) -> list[Finding]:
    """Check if .env files are in version control (only in --committed mode)."""
    if file_type != "env-file":
        return []
    if not committed_only:
        return []  # In full scans, local .env files are expected
    return [Finding(
        severity="critical",
        category="secrets",
        title="Environment file committed to git",
        description=f"{path} is tracked by git and contains environment variables. "
                    "Remove from version control and add to .gitignore.",
        file=str(path),
    )]


# ─── Main Scanner ──────────────────────────────────────────

def scan(root: Path, committed_only: bool = False) -> list[Finding]:
    """Run all checks against discovered files."""
    files = discover_files(root, committed_only)
    all_findings = []

    for path, content in files:
        file_type = classify_file(path)

        all_findings.extend(check_secrets(path, content))
        all_findings.extend(check_hidden_unicode(path, content))
        all_findings.extend(check_url_execution(path, content))
        all_findings.extend(check_prompt_defense(path, content, file_type))
        all_findings.extend(check_env_committed(path, content, file_type, committed_only))

    # Sort by severity
    all_findings.sort(key=lambda f: SEVERITY_ORDER.get(f.severity, 99))
    return all_findings


def grade(findings: list[Finding]) -> str:
    """Calculate a letter grade from findings."""
    score = 100
    for f in findings:
        if f.severity == "critical":
            score -= 20
        elif f.severity == "high":
            score -= 10
        elif f.severity == "medium":
            score -= 3
        elif f.severity == "low":
            score -= 1
    score = max(0, score)
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 50:
        return "D"
    return "F"


# ─── Output ────────────────────────────────────────────────

SEVERITY_COLORS = {
    "critical": "\033[1;31m",  # bold red
    "high": "\033[31m",        # red
    "medium": "\033[33m",      # yellow
    "low": "\033[36m",         # cyan
    "info": "\033[37m",        # white
}
RESET = "\033[0m"
BOLD = "\033[1m"


def print_terminal(findings: list[Finding]) -> None:
    """Pretty-print findings to terminal."""
    counts = {}
    for f in findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1

    g = grade(findings)
    print(f"\n{BOLD}🐾 SmolPaws Security Scan{RESET}")
    print(f"   Grade: {BOLD}{g}{RESET}")
    print(f"   Critical: {counts.get('critical', 0)} | "
          f"High: {counts.get('high', 0)} | "
          f"Medium: {counts.get('medium', 0)} | "
          f"Low: {counts.get('low', 0)}")
    print()

    if not findings:
        print("   ✅ No issues found. Clean scan.")
        return

    for f in findings:
        color = SEVERITY_COLORS.get(f.severity, "")
        icon = "🔴" if f.severity in ("critical", "high") else "🟡" if f.severity == "medium" else "🔵"
        loc = f":{f.line}" if f.line else ""
        print(f"   {icon} {color}{f.severity.upper()}{RESET}: {f.title}")
        print(f"      {f.file}{loc}")
        if f.evidence:
            print(f"      Evidence: {f.evidence}")
        print(f"      {f.description}")
        print()


def print_json(findings: list[Finding]) -> None:
    """Output findings as JSON."""
    output = {
        "grade": grade(findings),
        "total": len(findings),
        "counts": {},
        "findings": [asdict(f) for f in findings],
    }
    for f in findings:
        output["counts"][f.severity] = output["counts"].get(f.severity, 0) + 1
    print(json.dumps(output, indent=2))


# ─── CLI ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="SmolPaws security scanner")
    parser.add_argument("path", nargs="?", default=".", help="Directory to scan (default: .)")
    parser.add_argument("--committed", action="store_true", help="Only scan git-tracked files")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    findings = scan(root, committed_only=args.committed)

    if args.json:
        print_json(findings)
    else:
        print_terminal(findings)

    # Exit code: 1 if critical or high findings
    if any(f.severity in ("critical", "high") for f in findings):
        sys.exit(1)


if __name__ == "__main__":
    main()
