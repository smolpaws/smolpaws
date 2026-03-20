import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { Event, TextContent } from "@smolpaws/agent-sdk";
import {
  getLiveConversationOrThrow,
  buildEventsFilePath,
  toTrimmedStringArray,
} from "../runner/conversationService.js";
import { filterEvents } from "../runner/conversationState.js";
import {
  getConversationEventsOrThrow,
  paginateEvents,
} from "../runner/eventService.js";
import { isAuthorized, normalizeHeader } from "../runner/workspacePolicy.js";
import type { AgentServerDeps } from "./dependencies.js";
import {
  ConfirmationResponseSchema,
  ErrorSchema,
  EventBatchSchema,
  EventPageSchema,
  EventSchema,
  MessageSchema,
  SuccessSchema,
  type ConfirmationResponseRequest,
  type ErrorResponse,
  type EventBatch,
  type EventPage,
} from "./models.js";

export function registerEventRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.post<{ Params: { conversationId: string }; Body: ConfirmationResponseRequest; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/events/respond_to_confirmation",
    {
      schema: {
        body: ConfirmationResponseSchema,
        response: { 200: SuccessSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply): Promise<Static<typeof SuccessSchema> | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const record = getLiveConversationOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      if (request.body.accept) {
        await record.conversation.approveAction();
      } else {
        await record.conversation.rejectAction(request.body.reason);
      }
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof MessageSchema>; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/events",
    {
      schema: {
        body: MessageSchema,
        response: { 200: SuccessSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply): Promise<Static<typeof SuccessSchema> | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const record = getLiveConversationOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      if (request.body.role !== "user") {
        throw new Error("only_user_messages_supported");
      }
      const content = request.body.content as TextContent[];
      const messageText = deps.conversationRuntime.extractTextFromMessageRequest(
        request.body,
      );
      await record.conversation.sendUserMessage(messageText, {
        run: request.body.run !== false,
        extendedContent: request.body.extended_content as TextContent[] | undefined,
      });
      return { success: true };
    },
  );

  app.get<{
    Params: { conversationId: string };
    Querystring: {
      page_id?: string;
      limit?: string | number;
      kind?: string;
      source?: string;
      body?: string;
      sort_order?: string;
      timestamp__gte?: string;
      timestamp__lt?: string;
    };
    Reply: EventPage | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/events/search",
    {
      schema: { response: { 200: EventPageSchema, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema } },
    },
    async (request, reply): Promise<EventPage | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const events = await getConversationEventsOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      const filtered = filterEvents(events, {
        kind: request.query.kind,
        source: request.query.source,
        body: request.query.body,
        timestampGte: request.query.timestamp__gte,
        timestampLt: request.query.timestamp__lt,
        sortOrder: request.query.sort_order,
      });
      return paginateEvents(filtered, {
        pageId: request.query.page_id,
        limit: request.query.limit,
      });
    },
  );

  app.get<{
    Params: { conversationId: string };
    Querystring: {
      kind?: string;
      source?: string;
      body?: string;
      timestamp__gte?: string;
      timestamp__lt?: string;
    };
    Reply: number | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/events/count",
    {
      schema: {
        response: {
          200: Type.Number(),
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<number | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const events = await getConversationEventsOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      return filterEvents(events, {
        kind: request.query.kind,
        source: request.query.source,
        body: request.query.body,
        timestampGte: request.query.timestamp__gte,
        timestampLt: request.query.timestamp__lt,
      }).length;
    },
  );

  app.get<{
    Params: { conversationId: string; eventId: string };
    Reply: Event | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/events/:eventId",
    {
      schema: {
        response: {
          200: EventSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<Event | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const events = await getConversationEventsOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      const event = events.find(
        (candidate) =>
          (candidate as { id?: unknown }).id === request.params.eventId,
      );
      if (!event) {
        reply.status(404);
        return { error: "Event not found" };
      }
      return event;
    },
  );

  app.get<{
    Params: { conversationId: string };
    Querystring: {
      event_ids?: string | string[];
    };
    Reply: EventBatch | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/events",
    {
      schema: {
        response: {
          200: EventBatchSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<EventBatch | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const eventIds = toTrimmedStringArray(request.query.event_ids);
      if (eventIds.length === 0) {
        reply.status(400);
        return { error: "event_ids query parameter is required" };
      }
      const events = await getConversationEventsOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      return eventIds.map((eventId) =>
        events.find((event) => (event as { id?: unknown }).id === eventId) ?? null
      );
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { format?: string } }>(
    "/api/conversations/:conversationId/events/download",
    async (request, reply) => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401).send({ error: auth.reason ?? "Unauthorized" });
        return;
      }
      const conversationId = request.params.conversationId;
      const record = deps.conversationRuntime.conversations.get(conversationId);
      const eventsPath = buildEventsFilePath(
        conversationId,
        deps.persistenceRoot,
        record,
      );
      try {
        const content = await fs.readFile(eventsPath, "utf8");
        const format =
          typeof request.query.format === "string"
            ? request.query.format.toLowerCase()
            : "";
        const acceptEncoding =
          normalizeHeader(request.headers["accept-encoding"])?.toLowerCase() ??
          "";
        const shouldGzip =
          format === "gz" || format === "gzip" || acceptEncoding.includes("gzip");
        const body = shouldGzip ? gzipSync(content) : content;
        reply
          .header("Content-Type", "application/x-ndjson")
          .header(
            "Content-Disposition",
            `attachment; filename="${conversationId}.events.jsonl"`,
          );
        if (shouldGzip) {
          reply.header("Content-Encoding", "gzip");
        }
        reply.send(body);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          reply.status(404).send({ error: "Conversation events not found" });
          return;
        }
        throw error;
      }
    },
  );
}
