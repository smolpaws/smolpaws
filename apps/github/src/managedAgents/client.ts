import { jsonResponse } from './http.js';
import type { Provider, Status } from './types.js';

/** Small tool transport. The calling runtime holds only its Worker service token. */
export function managedAgentTools(baseUrl: string, serviceToken: string, fetchImpl: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Worker HTTPS origin required');
  const headers = { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' };
  async function ask(provider: Provider, input: { clientRequestId: string; issueNumber: number; body: string }): Promise<{ runs: Status[] }> {
    // Callers must retain the ID on retries. This client never retries a mutation automatically.
    return jsonResponse(await fetchImpl(new URL('/managed-agents/requests', base), { method: 'POST', redirect: 'error', headers,
      body: JSON.stringify({ ...input, provider, repositoryId: 1043426082 }), signal: AbortSignal.timeout(15_000) }));
  }
  return {
    ask_codex: (input: { clientRequestId: string; issueNumber: number; body: string }) => ask('codex', input),
    ask_claude: (input: { clientRequestId: string; issueNumber: number; body: string }) => ask('claude', input),
    async managed_agent_status(runId: string): Promise<Status> {
      if (!/^[\w-]{1,128}$/.test(runId)) throw new Error('Invalid run ID');
      return jsonResponse(await fetchImpl(new URL(`/managed-agents/runs/${runId}`, base), { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) }));
    },
  };
}
