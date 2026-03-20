import type { FastifyInstance } from "fastify";
import {
  isAllowedWorkspacePath,
  isAuthorized,
  resolveRequestedAbsolutePath,
} from "../runner/workspacePolicy.js";
import type { AgentServerDeps } from "./dependencies.js";
import {
  BashEventPageSchema,
  ErrorSchema,
  StartBashCommandRequestSchema,
  StartBashCommandResponseSchema,
  type BashEventPage,
  type ErrorResponse,
  type StartBashCommandRequest,
  type StartBashCommandResponse,
} from "./models.js";

export function registerBashRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.post<{ Body: StartBashCommandRequest; Reply: StartBashCommandResponse | ErrorResponse }>(
    "/api/bash/start_bash_command",
    {
      schema: {
        body: StartBashCommandRequestSchema,
        response: {
          200: StartBashCommandResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<StartBashCommandResponse | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }

      const rawCwd = request.body.cwd ?? process.cwd();
      let cwd: string;
      try {
        cwd = resolveRequestedAbsolutePath(rawCwd);
      } catch (error) {
        reply.status(400);
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }

      try {
        if (!(await isAllowedWorkspacePath(cwd, deps.env, "read"))) {
          reply.status(403);
          return { error: "Path is outside allowed workspace roots" };
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          reply.status(400);
          return { error: "Working directory not found" };
        }
        throw error;
      }

      const timeoutSeconds =
        typeof request.body.timeout === "number" && Number.isFinite(request.body.timeout)
          ? Math.max(1, Math.trunc(request.body.timeout))
          : 30;
      const record = deps.bashService.startCommand(
        request.body.command,
        cwd,
        timeoutSeconds,
      );
      return { id: record.id };
    },
  );

  app.get<{ Querystring: { command_id__eq?: string; kind__eq?: string }; Reply: BashEventPage | ErrorResponse }>(
    "/api/bash/bash_events/search",
    {
      schema: {
        response: {
          200: BashEventPageSchema,
          401: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<BashEventPage | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }

      return deps.bashService.searchEvents(
        request.query.command_id__eq,
        request.query.kind__eq,
      );
    },
  );
}
