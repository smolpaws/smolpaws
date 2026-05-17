import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { existsSync } from "node:fs";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createRequire } from "module";
import path from "path";
import { createAgentServerDeps, type AgentServerDeps } from "./dependencies.js";
import { assertSafeRunnerBind, resolveRunnerHost } from "../runner/workspacePolicy.js";
import { registerServerDetailsRoutes } from "./serverDetailsRouter.js";
import { registerSocketRoutes } from "./sockets.js";
import { registerFileRoutes } from "./fileRouter.js";
import { registerGitRoutes } from "./gitRouter.js";
import { registerBashRoutes } from "./bashRouter.js";
import { registerConversationRoutes } from "./conversationRouter.js";
import { registerEventRoutes } from "./eventRouter.js";
import { registerActivityRoutes } from "./activityRouter.js";

export const AGENT_SERVER_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const require = createRequire(import.meta.url);

function resolveInstalledPackageVersion(packageName: string): string {
  let currentDir = path.dirname(require.resolve(packageName));
  while (true) {
    const manifestPath = path.join(currentDir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = require(manifestPath) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === packageName && typeof manifest.version === "string") {
        return manifest.version;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`package_manifest_not_found:${packageName}`);
    }
    currentDir = parentDir;
  }
}

const AGENT_SDK_VERSION = resolveInstalledPackageVersion("@smolpaws/agent-sdk");

function registerErrorHandler(
  app: FastifyInstance,
): void {
  app.setErrorHandler((
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (error instanceof Error && error.message === "conversation_not_found") {
      reply.status(404).send({ error: "Conversation not found" });
      return;
    }
    if (error instanceof Error && error.message === "conversation_not_live") {
      reply.status(409).send({
        error: "Conversation exists in persistence but is not active in memory",
      });
      return;
    }
    if (error instanceof Error && error.message === "turn_not_found") {
      reply.status(404).send({ error: "Turn not found" });
      return;
    }
    if (error instanceof Error && error.message === "delivery_owner_conflict") {
      reply.status(409).send({ error: "Turn delivery is owned by another caller." });
      return;
    }
    if (error instanceof Error && error.message === "only_user_messages_supported") {
      reply.status(400).send({ error: "Only user messages are supported" });
      return;
    }
    if (error instanceof Error && error.message === "workspace_root_not_allowed") {
      reply.status(403).send({ error: "Workspace root is outside allowed roots" });
      return;
    }
    if (error instanceof Error && error.message === "invalid_conversation_id") {
      reply.status(400).send({ error: "Conversation id is invalid" });
      return;
    }
    if (error instanceof Error && error.message.startsWith("unsupported_tool:")) {
      reply.status(400).send({
        error: `Unsupported tool requested: ${error.message.slice("unsupported_tool:".length)}`,
      });
      return;
    }
    if (error instanceof Error && error.message === "queued_run_not_supported") {
      request.log.error(
        { err: error },
        "Queued idle run requested but SDK lacks queued-run support",
      );
      reply.status(501).send({
        error: "Queued idle run is not supported by this runner version.",
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    reply.status(500).send({ error: message });
  });
}

export async function createAgentServerApp(
  deps: AgentServerDeps = createAgentServerDeps(),
) {
  const app = Fastify({
    bodyLimit: AGENT_SERVER_BODY_LIMIT_BYTES,
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();
  app.log.info({ agentSdkVersion: AGENT_SDK_VERSION }, "Loaded @smolpaws/agent-sdk");
  await app.register(websocket);
  await app.register(multipart);

  registerServerDetailsRoutes(app, deps);
  registerSocketRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerGitRoutes(app, deps);
  registerBashRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerActivityRoutes(app, deps);
  registerErrorHandler(app);

  return { app, deps };
}

export async function startAgentServer(
  deps: AgentServerDeps = createAgentServerDeps(),
): Promise<void> {
  const { app } = await createAgentServerApp(deps);
  const port = Number(deps.env.PORT ?? deps.env.RUNNER_PORT ?? 8788);
  const host = resolveRunnerHost(deps.env);
  assertSafeRunnerBind(deps.env);
  await app.listen({ port, host });
}
