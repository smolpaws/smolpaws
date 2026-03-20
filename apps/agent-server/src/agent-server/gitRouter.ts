import type { FastifyInstance } from "fastify";
import type { AgentServerDeps } from "./dependencies.js";
import {
  ErrorSchema,
  GitChangesSchema,
  GitDiffSchema,
  GitPathQuerySchema,
  type ErrorResponse,
  type GitChange,
  type GitDiff,
  type GitPathQuery,
} from "./models.js";
import { getGitChanges, getGitDiff, handleGitRoute } from "./gitService.js";

export function registerGitRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.get<{ Querystring: GitPathQuery; Reply: GitChange[] | ErrorResponse }>(
    "/api/git/changes",
    {
      schema: {
        querystring: GitPathQuerySchema,
        response: {
          200: GitChangesSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<GitChange[] | ErrorResponse> => {
      return handleGitRoute(
        request,
        reply,
        deps.env,
        request.query.path,
        getGitChanges,
      );
    },
  );

  app.get<{ Querystring: GitPathQuery; Reply: GitDiff | ErrorResponse }>(
    "/api/git/diff",
    {
      schema: {
        querystring: GitPathQuerySchema,
        response: {
          200: GitDiffSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<GitDiff | ErrorResponse> => {
      return handleGitRoute(
        request,
        reply,
        deps.env,
        request.query.path,
        getGitDiff,
      );
    },
  );

  app.get<{ Params: { "*": string }; Reply: GitChange[] | ErrorResponse }>(
    "/api/git/changes/*",
    {
      schema: {
        response: {
          200: GitChangesSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<GitChange[] | ErrorResponse> => {
      return handleGitRoute(
        request,
        reply,
        deps.env,
        request.params["*"],
        getGitChanges,
      );
    },
  );

  app.get<{ Params: { "*": string }; Reply: GitDiff | ErrorResponse }>(
    "/api/git/diff/*",
    {
      schema: {
        response: {
          200: GitDiffSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<GitDiff | ErrorResponse> => {
      return handleGitRoute(
        request,
        reply,
        deps.env,
        request.params["*"],
        getGitDiff,
      );
    },
  );
}
