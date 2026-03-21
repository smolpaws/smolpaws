import type { FastifyInstance } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { TextContent } from "@smolpaws/agent-sdk";
import {
  buildConversationInfo,
  getConversationInfoOrThrow,
  getLiveConversationOrThrow,
  hasPersistedConversation,
  listConversationInfos,
  paginateConversationInfos,
  sortConversationInfos,
  filterConversationInfos,
  toTrimmedStringArray,
} from "../runner/conversationService.js";
import {
  deriveExecutionStatusFromEvents,
  generateTitleFromEvents,
} from "../runner/conversationState.js";
import { readPersistedEventsOrThrow } from "../runner/eventService.js";
import { isAuthorized } from "../runner/workspacePolicy.js";
import { claimOutboundMessages, claimTaskCommands } from "../runner/outbox.js";
import type { AgentServerDeps } from "./dependencies.js";
import {
  AskAgentRequestSchema,
  AskAgentResponseSchema,
  ConversationBatchSchema,
  ConversationInfoSchema,
  ConversationListSchema,
  ConversationPageSchema,
  ErrorSchema,
  GenerateTitleRequestSchema,
  GenerateTitleResponseSchema,
  SetConfirmationPolicyRequestSchema,
  SetSecretsRequestSchema,
  SetSecurityAnalyzerRequestSchema,
  SmolpawsOutboundMessageListSchema,
  SmolpawsTaskCommandListSchema,
  StartConversationRequestSchema,
  SuccessSchema,
  UpdateConversationRequestSchema,
  type AskAgentResponse,
  type ConversationBatch,
  type ConversationInfo,
  type ConversationList,
  type ConversationPage,
  type ErrorResponse,
  type GenerateTitleResponse,
} from "./models.js";

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: AgentServerDeps,
): void {
  app.get<{
    Querystring: {
      ids?: string | string[];
    };
    Reply: ConversationList | ConversationBatch | ErrorResponse;
  }>(
    "/api/conversations",
    {
      schema: {
        response: {
          200: Type.Union([ConversationListSchema, ConversationBatchSchema]),
          401: ErrorSchema,
          400: ErrorSchema,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<ConversationList | ConversationBatch | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const requestedIds = toTrimmedStringArray(request.query.ids);
      const allInfos = await listConversationInfos(
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
        deriveExecutionStatusFromEvents,
      );
      if (requestedIds.length > 0) {
        if (
          requestedIds.length > 100 ||
          requestedIds.some((conversationId) => !conversationId || conversationId.includes("/"))
        ) {
          reply.status(400);
          return {
            error: "Conversation ids must be valid and limited to 100 items.",
          };
        }
        const infoMap = new Map(allInfos.map((info) => [info.id, info]));
        return requestedIds.map((conversationId) => infoMap.get(conversationId) ?? null);
      }
      return { items: allInfos };
    },
  );

  app.get<{
    Querystring: {
      page_id?: string;
      limit?: string | number;
      status?: string;
      sort_order?: string;
    };
    Reply: ConversationPage | ErrorResponse;
  }>(
    "/api/conversations/search",
    {
      schema: {
        response: {
          200: ConversationPageSchema,
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<ConversationPage | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const items = sortConversationInfos(
        filterConversationInfos(
          await listConversationInfos(
            deps.persistenceRoot,
            deps.conversationRuntime.conversations,
            deriveExecutionStatusFromEvents,
          ),
          {
            status: request.query.status,
          },
        ),
        typeof request.query.sort_order === "string"
          ? request.query.sort_order
          : undefined,
      );
      return paginateConversationInfos(items, {
        pageId: request.query.page_id,
        limit: request.query.limit,
      });
    },
  );

  app.get<{
    Querystring: {
      status?: string;
    };
    Reply: number | ErrorResponse;
  }>(
    "/api/conversations/count",
    {
      schema: {
        response: {
          200: Type.Number(),
          401: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<number | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const items = filterConversationInfos(
        await listConversationInfos(
          deps.persistenceRoot,
          deps.conversationRuntime.conversations,
          deriveExecutionStatusFromEvents,
        ),
        { status: request.query.status },
      );
      return items.length;
    },
  );

  app.post<{ Body: Static<typeof StartConversationRequestSchema>; Reply: ConversationInfo | ErrorResponse }>(
    "/api/conversations",
    {
      schema: {
        body: StartConversationRequestSchema,
        response: {
          200: ConversationInfoSchema,
          201: ConversationInfoSchema,
          401: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<ConversationInfo | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const { record, isNew } = await deps.conversationRuntime.createConversationRecord(
        request.body,
      );
      if (request.body.initial_message) {
        const messageText = deps.conversationRuntime.extractTextFromMessageRequest(
          request.body.initial_message,
        );
        if (messageText) {
          await record.conversation.sendUserMessage(messageText, {
            run: request.body.initial_message.run !== false,
            extendedContent: request.body.initial_message
              .extended_content as TextContent[] | undefined,
          });
        }
      }
      reply.status(isNew ? 201 : 200);
      return buildConversationInfo(record, deriveExecutionStatusFromEvents);
    },
  );

  app.get<{ Params: { conversationId: string }; Reply: ConversationInfo | ErrorResponse }>(
    "/api/conversations/:conversationId",
    {
      schema: {
        response: {
          200: ConversationInfoSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply): Promise<ConversationInfo | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      return getConversationInfoOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
        deriveExecutionStatusFromEvents,
      );
    },
  );

  app.patch<{
    Params: { conversationId: string };
    Body: Static<typeof UpdateConversationRequestSchema>;
    Reply: Static<typeof SuccessSchema> | ErrorResponse;
  }>(
    "/api/conversations/:conversationId",
    {
      schema: {
        body: UpdateConversationRequestSchema,
        response: {
          200: SuccessSchema,
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<Static<typeof SuccessSchema> | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const success = await deps.conversationRuntime.updateConversationTitle(
        request.params.conversationId,
        request.body.title,
      );
      return { success };
    },
  );

  app.delete<{
    Params: { conversationId: string };
    Reply: Static<typeof SuccessSchema> | ErrorResponse;
  }>(
    "/api/conversations/:conversationId",
    {
      schema: {
        response: {
          200: SuccessSchema,
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<Static<typeof SuccessSchema> | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const deleted = await deps.conversationRuntime.deleteConversation(
        request.params.conversationId,
      );
      if (!deleted) {
        reply.status(400);
        return { error: "Conversation could not be deleted." };
      }
      return { success: true };
    },
  );

  app.post<{
    Params: { conversationId: string };
    Reply: Static<typeof SmolpawsOutboundMessageListSchema> | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/outbound_messages/claim",
    {
      schema: {
        response: {
          200: SmolpawsOutboundMessageListSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const conversationId = request.params.conversationId;
      const record = deps.conversationRuntime.conversations.get(conversationId);
      const persisted = hasPersistedConversation(conversationId, deps.persistenceRoot);
      if (!record && !persisted) {
        reply.status(404);
        return { error: "Conversation not found" };
      }
      return await claimOutboundMessages(conversationId, deps.persistenceRoot);
    },
  );

  app.post<{
    Params: { conversationId: string };
    Reply: Static<typeof SmolpawsTaskCommandListSchema> | ErrorResponse;
  }>(
    "/api/conversations/:conversationId/task_commands/claim",
    {
      schema: {
        response: {
          200: SmolpawsTaskCommandListSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      const conversationId = request.params.conversationId;
      const record = deps.conversationRuntime.conversations.get(conversationId);
      const persisted = hasPersistedConversation(conversationId, deps.persistenceRoot);
      if (!record && !persisted) {
        reply.status(404);
        return { error: "Conversation not found" };
      }
      return await claimTaskCommands(conversationId, deps.persistenceRoot);
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/pause",
    {
      schema: { response: { 200: SuccessSchema, 401: ErrorSchema, 409: ErrorSchema } },
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
      await record.conversation.pause();
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/run",
    {
      schema: { response: { 200: SuccessSchema, 400: ErrorSchema, 401: ErrorSchema, 409: ErrorSchema } },
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
      const executionStatus = deriveExecutionStatusFromEvents(record.events);
      switch (executionStatus) {
        case "paused":
          await record.conversation.resume();
          return { success: true };
        case "running":
          reply.status(409);
          return {
            error: "Conversation already running. Wait for completion or pause first.",
          };
        case "waiting_for_confirmation":
          reply.status(409);
          return {
            error: "Conversation is waiting for confirmation. Approve or reject the pending action first.",
          };
        default:
          if (deps.conversationRuntime.hasQueuedUserMessage(record.events)) {
            await deps.conversationRuntime.runQueuedConversation(record);
            return { success: true };
          }
          reply.status(400);
          return {
            error: `This runner can only run paused conversations; current status is '${executionStatus}'.`,
          };
      }
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof SetConfirmationPolicyRequestSchema>; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/confirmation_policy",
    {
      schema: {
        body: SetConfirmationPolicyRequestSchema,
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
      await deps.conversationRuntime.applyConfirmationPolicy(record, request.body);
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof SetSecurityAnalyzerRequestSchema>; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/security_analyzer",
    {
      schema: {
        body: SetSecurityAnalyzerRequestSchema,
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
      await deps.conversationRuntime.applySecurityAnalyzer(record, request.body);
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof SetSecretsRequestSchema>; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/secrets",
    {
      schema: {
        body: SetSecretsRequestSchema,
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
      deps.conversationRuntime.registerSecrets(
        request.body.secrets,
        record.secrets,
        record.settings,
      );
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof AskAgentRequestSchema>; Reply: AskAgentResponse | ErrorResponse }>(
    "/api/conversations/:conversationId/ask_agent",
    {
      schema: {
        body: AskAgentRequestSchema,
        response: { 200: AskAgentResponseSchema, 401: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request, reply): Promise<AskAgentResponse | ErrorResponse> => {
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
      const response = await deps.conversationRuntime.runStandaloneQuestion(
        record.settings,
        request.body.question,
        record.workspaceRoot,
        deps.persistenceRoot,
        { toolProfile: record.toolProfile },
      );
      return { response: response.reply };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof GenerateTitleRequestSchema>; Reply: GenerateTitleResponse | ErrorResponse }>(
    "/api/conversations/:conversationId/generate_title",
    {
      schema: {
        body: GenerateTitleRequestSchema,
        response: { 200: GenerateTitleResponseSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (request, reply): Promise<GenerateTitleResponse | ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      if (request.body.llm !== undefined && request.body.llm !== null) {
        reply.status(400);
        return {
          error: "custom title-generation llm is not supported by this runner yet",
        };
      }
      const maxLength =
        typeof request.body.max_length === "number"
          ? Math.max(1, Math.trunc(request.body.max_length))
          : 50;
      const record = deps.conversationRuntime.conversations.get(
        request.params.conversationId,
      );
      const events = record
        ? record.events
        : await readPersistedEventsOrThrow(
            request.params.conversationId,
            deps.persistenceRoot,
          );
      return { title: generateTitleFromEvents(events, maxLength) };
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> | ErrorResponse }>(
    "/api/conversations/:conversationId/condense",
    {
      schema: { response: { 400: ErrorSchema, 401: ErrorSchema, 409: ErrorSchema } },
    },
    async (request, reply): Promise<ErrorResponse> => {
      const auth = isAuthorized(request, deps.env);
      if (!auth.allowed) {
        reply.status(401);
        return { error: auth.reason ?? "Unauthorized" };
      }
      getLiveConversationOrThrow(
        request.params.conversationId,
        deps.persistenceRoot,
        deps.conversationRuntime.conversations,
      );
      reply.status(400);
      return { error: "forced condensation is not supported by this runner yet" };
    },
  );
}
