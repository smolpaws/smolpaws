import path from 'node:path';
import { defaultSchedulerPath } from '../../../src/coordinator/taskScheduler.js';

/** The host's worker must never consume a bridge's durable intake or delivery rows. */
export function nativeRelayDbPath(
  schedulerPath = defaultSchedulerPath(),
  override = process.env.SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH,
): string {
  return override?.trim() || path.join(path.dirname(schedulerPath), 'agent-server-relay-v1.db');
}
