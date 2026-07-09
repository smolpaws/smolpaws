import path from 'node:path';

export interface AgentServerConfig {
  readonly sessionApiKey?: string | null;
  readonly staticFilesPath?: string | null;
  readonly webUrl?: string | null;
  readonly conversationsPath: string;
  readonly bashEventsPath: string;
}

export function getDefaultConfig(env: Record<string, string | undefined> = process.env): AgentServerConfig {
  const conversationsPath = env.OPENHANDS_CONVERSATIONS_PATH ?? env.PERSISTENCE_DIR ?? 'workspace/conversations';
  return {
    sessionApiKey: env.OPENHANDS_SESSION_API_KEY ?? env.SESSION_API_KEY ?? null,
    staticFilesPath: env.STATIC_FILES_PATH ?? null,
    webUrl: env.WEB_URL ?? null,
    conversationsPath,
    bashEventsPath: env.OPENHANDS_BASH_EVENTS_PATH ?? path.join(conversationsPath, 'bash_events'),
  };
}
