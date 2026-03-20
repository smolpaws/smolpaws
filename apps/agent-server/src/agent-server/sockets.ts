import type { FastifyInstance } from "fastify";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Event, TextContent } from "@smolpaws/agent-sdk";
import type { AgentServerDeps } from "./dependencies.js";
import {
  ConversationIdParamsSchema,
  MessageSchema,
  SocketsEventsQuerySchema,
  type ConversationIdParams,
  type SocketsEventsQuery,
} from "./models.js";
import { isAuthorized } from "../runner/workspacePolicy.js";
import { isTextContentLike, extractMessageText } from "../runner/messageText.js";

const OPEN_SOCKET_STATE = 1;

export function registerSocketRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.get<{
    Params: ConversationIdParams;
    Querystring: SocketsEventsQuery;
  }>(
    "/sockets/events/:conversationId",
    {
      websocket: true,
      schema: {
        params: ConversationIdParamsSchema,
        querystring: SocketsEventsQuerySchema,
      },
      preValidation: async (request, reply) => {
        const auth = isAuthorized(request, deps.env, {
          sessionApiKey: request.query.session_api_key,
        });
        if (!auth.allowed) {
          reply.status(401).send({ error: auth.reason ?? "Unauthorized" });
          return;
        }
        deps.conversationRuntime.getConversationOrThrow(
          request.params.conversationId,
        );
      },
    },
    (socket, request) => {
      const record = deps.conversationRuntime.getConversationOrThrow(
        request.params.conversationId,
      );
      const sendEvent = (event: Event) => {
        if (socket.readyState !== OPEN_SOCKET_STATE) {
          return;
        }
        socket.send(JSON.stringify(event));
      };
      const replayEvents =
        request.query.resend_all === "true" ? [...record.events] : [];
      const unsubscribe = deps.conversationRuntime.addEventSubscriber(
        record.id,
        sendEvent,
      );
      for (const event of replayEvents) {
        sendEvent(event);
      }
      socket.on("message", (data: unknown) => {
        void (async () => {
          try {
            const raw = Buffer.isBuffer(data)
              ? data.toString()
              : Array.isArray(data)
                ? Buffer.concat(data).toString()
                : data instanceof ArrayBuffer
                  ? Buffer.from(data).toString()
                  : String(data);
            const payload = JSON.parse(raw) as unknown;
            if (!Value.Check(MessageSchema, payload) || payload.role !== "user") {
              return;
            }
            const typedPayload = payload as Static<typeof MessageSchema>;
            const content = typedPayload.content.filter(isTextContentLike);
            await record.conversation.sendUserMessage(
              extractMessageText(content),
              {
                run: true,
                extendedContent: Array.isArray(typedPayload.extended_content)
                  ? typedPayload.extended_content.filter(isTextContentLike)
                  : undefined,
              },
            );
          } catch (error) {
            console.error("websocket_message_error", error);
          }
        })();
      });
      socket.on("close", unsubscribe);
      socket.on("error", unsubscribe);
    },
  );
}
