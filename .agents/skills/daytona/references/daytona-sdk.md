# Daytona SDK essentials

Sources: [TypeScript SDK docs](https://www.daytona.io/docs/en/typescript-sdk.md), [Sandboxes](https://www.daytona.io/docs/en/sandboxes.md), and [Process & Code Execution](https://www.daytona.io/docs/en/process-code-execution.md).

## Install & configure

```bash
npm install @daytonaio/sdk
```

```ts
import { Daytona } from "@daytonaio/sdk";

// Env vars: DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET
const daytona = new Daytona();
// Or explicit config
const daytonaExplicit = new Daytona({
  apiKey: "YOUR_API_KEY",
  apiUrl: "https://app.daytona.io/api",
  target: "us",
});
```

## Create sandboxes

```ts
const sandbox = await daytona.create({ language: "typescript" });
```

Supported runtimes: `python`, `typescript`, `javascript` (default is python).

## Execute code / commands

```ts
const execResult = await sandbox.process.executeCommand("ls -la");
const codeResult = await sandbox.process.codeRun(`console.log("Hello Daytona")`);
```

Stateful code interpreter (Python only) uses `sandbox.codeInterpreter`.

## Lifecycle reminders

- `sandbox.stop()` keeps disk state.
- `sandbox.delete()` removes the sandbox.
- `autoStopInterval` can be set to `0` to disable auto-stop.
