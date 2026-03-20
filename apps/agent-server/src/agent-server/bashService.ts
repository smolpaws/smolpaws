import { randomUUID } from "crypto";
import { spawn } from "node:child_process";
import type { BashEventPage, BashOutputEvent } from "./models.js";

export type BashCommandRecord = {
  id: string;
  event: BashOutputEvent | null;
};

export function createBashService(onActivity: () => void) {
  const bashCommands = new Map<string, BashCommandRecord>();

  function startCommand(
    command: string,
    cwd: string,
    timeoutSeconds: number,
  ): BashCommandRecord {
    const commandId = randomUUID();
    const record: BashCommandRecord = { id: commandId, event: null };
    bashCommands.set(commandId, record);

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finalize = (exitCode: number, extraStderr = "") => {
      if (finished) {
        return;
      }
      finished = true;
      record.event = {
        kind: "BashOutput",
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        command_id: commandId,
        stdout,
        stderr: `${stderr}${extraStderr}`,
        exit_code: exitCode,
      };
      onActivity();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finalize(1, message);
    });
    child.on("close", (code) => {
      finalize(typeof code === "number" ? code : 1);
    });

    setTimeout(() => {
      if (finished) {
        return;
      }
      child.kill("SIGKILL");
      finalize(-1, `Command timed out after ${timeoutSeconds} seconds.`);
    }, Math.max(1, timeoutSeconds) * 1000);

    return record;
  }

  function searchEvents(
    commandId: string | undefined,
    kind: string | undefined,
  ): BashEventPage {
    if (kind && kind !== "BashOutput") {
      return { items: [] };
    }
    const normalizedCommandId = commandId?.trim();
    if (!normalizedCommandId) {
      return { items: [] };
    }
    const record = bashCommands.get(normalizedCommandId);
    if (!record?.event) {
      return { items: [] };
    }
    return { items: [record.event] };
  }

  return {
    startCommand,
    searchEvents,
  };
}

export type BashService = ReturnType<typeof createBashService>;
