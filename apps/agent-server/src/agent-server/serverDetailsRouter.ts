import type { FastifyInstance } from "fastify";
import { ServerInfoSchema } from "./models.js";
import type { AgentServerDeps } from "./dependencies.js";

export function registerServerDetailsRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/alive", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));
  app.get(
    "/server_info",
    {
      schema: {
        response: { 200: ServerInfoSchema },
      },
    },
    async () => ({
      uptime: Math.floor((Date.now() - deps.serverStart) / 1000),
      idle_time: Math.floor(
        (Date.now() - deps.conversationRuntime.getLastEventAt()) / 1000,
      ),
      title: "smolpaws agent server",
      version: "0.0.1",
      docs: "/docs",
      redoc: "/redoc",
    }),
  );
}
