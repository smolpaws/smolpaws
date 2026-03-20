// Basic Daytona sandbox demo using the TypeScript SDK.
// Requires DAYTONA_API_KEY in env, and @daytonaio/sdk installed.
import { Daytona } from "@daytonaio/sdk";

async function main(): Promise<void> {
  const daytona = new Daytona();
  const sandbox = await daytona.create({ language: "typescript", autoStopInterval: 0 });

  const exec = await sandbox.process.executeCommand("echo 'hello from daytona'");
  console.log(exec.result);

  // Example preview link for port 3000 (if a service is running).
  const preview = await sandbox.getPreviewLink(3000);
  console.log("Preview URL:", preview.url);
  console.log("Preview token:", preview.token);

  await sandbox.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
