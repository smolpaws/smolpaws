import {
  getEnv,
  resolveAbsolutePersistenceRoot,
  resolvePersistenceDir,
  type RunnerEnv,
} from "../runner/workspacePolicy.js";
import { createBashService } from "./bashService.js";
import {
  createConversationRuntime,
  type ConversationRuntime,
} from "./conversationRuntime.js";

export type AgentServerDeps = {
  env: RunnerEnv;
  persistenceDir: string;
  persistenceRoot: string;
  serverStart: number;
  conversationRuntime: ConversationRuntime;
  bashService: ReturnType<typeof createBashService>;
};

export function createAgentServerDeps(env = getEnv()): AgentServerDeps {
  const persistenceDir = resolvePersistenceDir(env);
  const persistenceRoot = resolveAbsolutePersistenceRoot(persistenceDir, env);
  const conversationRuntime = createConversationRuntime({
    env,
    persistenceDir,
    persistenceRoot,
  });
  const bashService = createBashService(() => {
    conversationRuntime.touch();
  });

  return {
    env,
    persistenceDir,
    persistenceRoot,
    serverStart: Date.now(),
    conversationRuntime,
    bashService,
  };
}
