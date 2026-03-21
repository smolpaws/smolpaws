import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createAgentServerDeps, type AgentServerDeps } from "./dependencies.js";
import { registerServerDetailsRoutes } from "./serverDetailsRouter.js";
import { registerSocketRoutes } from "./sockets.js";
import { registerFileRoutes } from "./fileRouter.js";
import { registerGitRoutes } from "./gitRouter.js";
import { registerBashRoutes } from "./bashRouter.js";
import { registerConversationRoutes } from "./conversationRouter.js";
import { registerEventRoutes } from "./eventRouter.js";

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
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(websocket);
  await app.register(multipart);

  registerServerDetailsRoutes(app, deps);
  registerSocketRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerGitRoutes(app, deps);
  registerBashRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerErrorHandler(app);

  return { app, deps };
}

export async function startAgentServer(
  deps: AgentServerDeps = createAgentServerDeps(),
): Promise<void> {
  const { app } = await createAgentServerApp(deps);
  const port = Number(deps.env.PORT ?? deps.env.RUNNER_PORT ?? 8788);
  await app.listen({ port, host: "0.0.0.0" });
}
