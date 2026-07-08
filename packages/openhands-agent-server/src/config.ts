export interface AgentServerConfig {
  readonly sessionApiKey?: string | null;
  readonly staticFilesPath?: string | null;
  readonly webUrl?: string | null;
}

export function getDefaultConfig(env: Record<string, string | undefined> = process.env): AgentServerConfig {
  return {
    sessionApiKey: env.OPENHANDS_SESSION_API_KEY ?? env.SESSION_API_KEY ?? null,
    staticFilesPath: env.STATIC_FILES_PATH ?? null,
    webUrl: env.WEB_URL ?? null,
  };
}
