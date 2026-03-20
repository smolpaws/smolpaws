// Example Daytona process session usage.
import { Daytona } from "@daytonaio/sdk";

async function main(): Promise<void> {
  const daytona = new Daytona();
  const sandbox = await daytona.create({ language: "typescript", autoStopInterval: 0 });

  const sessionId = "demo-session";
  await sandbox.process.createSession(sessionId);

  const command = await sandbox.process.executeSessionCommand(sessionId, {
    command: "node -e \"console.log('hello session')\"",
    runAsync: true,
  });

  await sandbox.process.getSessionCommandLogs(
    sessionId,
    command.cmdId!,
    (stdout) => console.log("stdout:", stdout),
    (stderr) => console.error("stderr:", stderr),
  );

  await sandbox.process.deleteSession(sessionId);
  await sandbox.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
