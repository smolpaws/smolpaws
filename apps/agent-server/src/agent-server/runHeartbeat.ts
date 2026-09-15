import { submitHeartbeat } from './heartbeatClient.js';
import { buildHeartbeatRequest, heartbeatRequestHeaders, resolveHeartbeatRunnerBaseUrl } from './heartbeat.js';

async function main(): Promise<void> {
  const baseUrl = resolveHeartbeatRunnerBaseUrl();
  const headers = heartbeatRequestHeaders();

  const now = new Date();
  const id = await submitHeartbeat(baseUrl, buildHeartbeatRequest(now), headers, now);
  console.log(`[heartbeat] queued conversation ${id}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[heartbeat] ${message}`);
  process.exitCode = 1;
});
