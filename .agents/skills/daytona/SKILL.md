---
name: daytona
description: Daytona sandbox infrastructure and SDK usage for running agent servers, executing commands, and previewing apps. Use when provisioning or managing Daytona sandboxes.
metadata:
  tags: daytona, sandbox, agent-sdk, preview, execution
  source: https://www.daytona.io/docs/en/
---

# Daytona

Use this skill when you need to run the Agent SDK server inside Daytona, provision sandboxes, or execute commands in isolated environments.

## Quick steps

1. Install the SDK: `npm install @daytonaio/sdk`.
2. Create a sandbox with the right runtime (`typescript`, `javascript`, or `python`).
3. Use `sandbox.process.executeCommand()` or `sandbox.process.codeRun()` for execution.
4. Use `sandbox.getPreviewLink()` / `getSignedPreviewUrl()` for preview URLs.
5. Stop or delete sandboxes when done.

## References

- [references/daytona-sdk.md](references/daytona-sdk.md) - SDK setup, sandbox lifecycle, and execution basics.
- [references/daytona-auth.md](references/daytona-auth.md) - API key setup and auth scopes.
- [references/daytona-preview.md](references/daytona-preview.md) - Preview URL and authentication details.
- [references/daytona-process-sessions.md](references/daytona-process-sessions.md) - Background process sessions and log streaming.
- [references/daytona-agent-sdk.md](references/daytona-agent-sdk.md) - Claude Agent SDK guide in Daytona.

## Scripts

- [scripts/daytona-sandbox.ts](scripts/daytona-sandbox.ts) - Create sandbox, run a command, fetch preview link.
