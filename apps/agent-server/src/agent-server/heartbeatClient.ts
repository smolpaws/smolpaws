import { buildHeartbeatEventId, type HeartbeatConversationRequest } from './heartbeat.js';

/** Creating an existing daily conversation does not append or run a new heartbeat. */
export async function submitHeartbeat(baseUrl: string, request: HeartbeatConversationRequest,
  headers: Record<string, string>, now: Date, fetcher: typeof fetch = fetch): Promise<string> {
  const { initial_message, ...conversation } = request;
  const created = await fetcher(`${baseUrl}/api/conversations`, {
    method: 'POST', headers, body: JSON.stringify(conversation),
  });
  if (!created.ok) throw new Error(`heartbeat_failed:${created.status}:${await created.text()}`);
  const payload = await created.json() as { id: string };
  // Deduplicate a retry within this scheduled minute, without suppressing later ticks that day.
  const eventId = buildHeartbeatEventId(request.conversation_id, now);
  const appended = await fetcher(`${baseUrl}/api/conversations/${payload.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ role: 'user', content: initial_message.content, run: false, event_id: eventId }),
  });
  if (!appended.ok) throw new Error(`heartbeat_failed:${appended.status}:${await appended.text()}`);
  const receipt = await appended.json() as { created: boolean };
  if (receipt.created) {
    const run = await fetcher(`${baseUrl}/api/conversations/${payload.id}/run`, { method: 'POST', headers, body: '{}' });
    if (!run.ok) throw new Error(`heartbeat_failed:${run.status}:${await run.text()}`);
  }
  return payload.id;
}
