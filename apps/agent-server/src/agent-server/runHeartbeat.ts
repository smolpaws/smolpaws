import { buildHeartbeatRequest, resolveHeartbeatRunnerBaseUrl } from './heartbeat.js';

async function main(): Promise<void> {
  const baseUrl = resolveHeartbeatRunnerBaseUrl();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (process.env.SMOLPAWS_RUNNER_TOKEN?.trim()) {
    headers.authorization = `Bearer ${process.env.SMOLPAWS_RUNNER_TOKEN.trim()}`;
  }

  const response = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildHeartbeatRequest(new Date())),
  });

  if (!response.ok) {
    throw new Error(`heartbeat_failed:${response.status}:${await response.text()}`);
  }

  const payload = await response.json().catch(() => ({}));
  const id = typeof payload?.id === 'string' ? payload.id : '(unknown)';
  console.log(`[heartbeat] queued conversation ${id}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[heartbeat] ${message}`);
  process.exitCode = 1;
});
