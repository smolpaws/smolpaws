import path from 'node:path';

export interface AgentServerConfig {
  readonly sessionApiKey?: string | null;
  readonly staticFilesPath?: string | null;
  readonly webUrl?: string | null;
  readonly conversationsPath: string;
  readonly bashEventsPath: string;
  readonly workspaceRoot: string;
  readonly allowedFileRoots: readonly string[];
}

export function getDefaultConfig(env: Record<string, string | undefined> = process.env): AgentServerConfig {
  const conversationsPath = env.OPENHANDS_CONVERSATIONS_PATH ?? env.PERSISTENCE_DIR ?? 'workspace/conversations';
  const workspaceRoot = env.OPENHANDS_WORKSPACE_ROOT ?? env.WORKSPACE_ROOT ?? env.SMOLPAWS_WORKSPACE_ROOT ?? process.cwd();
  const extraRoots = splitPathList(env.OPENHANDS_ALLOWED_FILE_ROOTS ?? env.SMOLPAWS_ALLOWED_WRITE_ROOTS);
  return {
    sessionApiKey: env.OPENHANDS_SESSION_API_KEY ?? env.SESSION_API_KEY ?? null,
    staticFilesPath: env.STATIC_FILES_PATH ?? null,
    webUrl: env.WEB_URL ?? null,
    conversationsPath,
    bashEventsPath: env.OPENHANDS_BASH_EVENTS_PATH ?? path.join(conversationsPath, 'bash_events'),
    workspaceRoot,
    allowedFileRoots: [workspaceRoot, ...extraRoots],
  };
}

function splitPathList(value: string | undefined): readonly string[] {
  return value?.split(path.delimiter).map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
}
