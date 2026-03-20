# Daytona process sessions

Source: [Process & Code Execution](https://www.daytona.io/docs/en/process-code-execution.md).

## When to use sessions

- Long-running commands (servers, watchers, background jobs).
- Interactive commands that require input (package managers, CLIs).
- Streaming logs while the process continues to run.

## TypeScript session flow

```ts
const sessionId = "my-session";
await sandbox.process.createSession(sessionId);

const command = await sandbox.process.executeSessionCommand(sessionId, {
  command: "npm run dev",
  runAsync: true,
});

await sandbox.process.getSessionCommandLogs(
  sessionId,
  command.cmdId!,
  (stdout) => console.log("stdout:", stdout),
  (stderr) => console.error("stderr:", stderr),
);

await sandbox.process.sendSessionCommandInput(sessionId, command.cmdId!, "y");
await sandbox.process.deleteSession(sessionId);
```

## Tips

- Always delete sessions when work is finished.
- Use `getSession` / `listSessions` to inspect running sessions.
- Use `sendSessionCommandInput` for interactive prompts.
