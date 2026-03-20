import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  isAllowedWorkspacePath,
  isAuthorized,
  resolveRequestedAbsolutePath,
} from "../runner/workspacePolicy.js";
import type { AgentServerDeps } from "./dependencies.js";

export function registerFileRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.get<{ Params: { "*": string } }>(
    "/api/file/download/*",
    async (request, reply) => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401).send({ error: auth.reason ?? "Unauthorized" });
        return;
      }

      const rawPath = request.params["*"];
      let absolutePath: string;
      try {
        absolutePath = resolveRequestedAbsolutePath(rawPath);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        reply.status(400).send({ error: message });
        return;
      }

      try {
        if (!(await isAllowedWorkspacePath(absolutePath, deps.env, "read"))) {
          reply.status(403).send({
            error: "Path is outside allowed workspace roots",
          });
          return;
        }

        const content = await fs.readFile(absolutePath);
        reply.header("Content-Type", "application/octet-stream");
        reply.send(content);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          reply.status(404).send({ error: "File not found" });
          return;
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { "*": string } }>(
    "/api/file/upload/*",
    async (request, reply) => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401).send({ error: auth.reason ?? "Unauthorized" });
        return;
      }

      const rawPath = request.params["*"];
      let absolutePath: string;
      try {
        absolutePath = resolveRequestedAbsolutePath(rawPath);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        reply.status(400).send({ error: message });
        return;
      }

      if (!(await isAllowedWorkspacePath(absolutePath, deps.env, "write"))) {
        reply.status(403).send({
          error: "Path is outside allowed workspace roots",
        });
        return;
      }

      const part = await request.file();
      if (!part) {
        reply.status(400).send({ error: "Missing file upload payload" });
        return;
      }

      const bytes = await part.toBuffer();
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, bytes);
      reply.send({ success: true });
    },
  );
}
