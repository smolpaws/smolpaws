import { Type, type Static } from "@sinclair/typebox";
import {
  SmolpawsConversationConfigSchema,
  SmolpawsOutboundMessageListSchema,
  SmolpawsRunnerRequestSchema,
  SmolpawsRunnerResponseSchema,
  SmolpawsTaskCommandListSchema,
} from "../shared/runner.js";

export {
  SmolpawsConversationConfigSchema,
  SmolpawsOutboundMessageListSchema,
  SmolpawsRunnerRequestSchema,
  SmolpawsRunnerResponseSchema,
  SmolpawsTaskCommandListSchema,
};

export const TextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: true },
);

export const ContentSchema = Type.Union([
  TextContentSchema,
  Type.Object({ type: Type.String() }, { additionalProperties: true }),
]);

export const MessageSchema = Type.Object(
  {
    role: Type.String(),
    content: Type.Array(ContentSchema),
    extended_content: Type.Optional(Type.Array(ContentSchema)),
    run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export const StaticSecretSchema = Type.Object(
  {
    kind: Type.Literal("StaticSecret"),
    value: Type.String(),
  },
  { additionalProperties: true },
);

export const SecretValueSchema = Type.Union([Type.String(), StaticSecretSchema]);

export const RemoteSecurityAnalyzerSchema = Type.Object(
  {
    kind: Type.Literal("LLMSecurityAnalyzer"),
  },
  { additionalProperties: true },
);

export const ConfirmationPolicySchema = Type.Union([
  Type.Object({ kind: Type.Literal("AlwaysConfirm") }, { additionalProperties: true }),
  Type.Object({ kind: Type.Literal("NeverConfirm") }, { additionalProperties: true }),
  Type.Object(
    {
      kind: Type.Literal("ConfirmRisky"),
      threshold: Type.Union([
        Type.Literal("LOW"),
        Type.Literal("MEDIUM"),
        Type.Literal("HIGH"),
      ]),
      confirm_unknown: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  ),
]);

export const LlmSchema = Type.Object(
  {
    usage_id: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    base_url: Type.Optional(Type.String()),
    api_key: Type.Optional(Type.String()),
    api_version: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
    temperature: Type.Optional(Type.Number()),
    top_p: Type.Optional(Type.Number()),
    top_k: Type.Optional(Type.Number()),
    max_input_tokens: Type.Optional(Type.Number()),
    max_output_tokens: Type.Optional(Type.Number()),
    reasoning_effort: Type.Optional(Type.String()),
    reasoning_summary: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const WorkspaceSchema = Type.Object(
  {
    kind: Type.Optional(Type.String()),
    working_dir: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const AgentSchema = Type.Object(
  {
    llm: LlmSchema,
    tools: Type.Optional(Type.Array(Type.Any())),
    security_analyzer: Type.Optional(RemoteSecurityAnalyzerSchema),
  },
  { additionalProperties: true },
);

export const StartConversationRequestSchema = Type.Object(
  {
    agent: AgentSchema,
    workspace: Type.Optional(WorkspaceSchema),
    secrets: Type.Optional(Type.Record(Type.String(), SecretValueSchema)),
    confirmation_policy: Type.Optional(ConfirmationPolicySchema),
    max_iterations: Type.Optional(Type.Number()),
    stuck_detection: Type.Optional(Type.Boolean()),
    stuck_detection_thresholds: Type.Optional(Type.Record(Type.String(), Type.Number())),
    initial_message: Type.Optional(MessageSchema),
    conversation_id: Type.Optional(Type.String()),
    smolpaws: Type.Optional(SmolpawsConversationConfigSchema),
  },
  { additionalProperties: true },
);

export const SuccessSchema = Type.Object({ success: Type.Boolean() });
export const ErrorSchema = Type.Object({ error: Type.String() });

export const EventSchema = Type.Object(
  {
    kind: Type.String(),
  },
  { additionalProperties: true },
);

export const EventPageSchema = Type.Object({
  items: Type.Array(EventSchema),
  next_page_id: Type.Optional(Type.String()),
});

export const EventBatchSchema = Type.Array(Type.Union([EventSchema, Type.Null()]));

export const ConversationInfoSchema = Type.Object({
  id: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  execution_status: Type.String(),
  title: Type.Optional(Type.String()),
});

export const ConversationPageSchema = Type.Object({
  items: Type.Array(ConversationInfoSchema),
  next_page_id: Type.Optional(Type.String()),
});

export const ConversationBatchSchema = Type.Array(
  Type.Union([ConversationInfoSchema, Type.Null()]),
);

export const AskAgentRequestSchema = Type.Object({ question: Type.String() });
export const AskAgentResponseSchema = Type.Object({ response: Type.String() });

export const ConversationListSchema = Type.Object({
  items: Type.Array(ConversationInfoSchema),
});

export const UpdateConversationRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
});

export const StartBashCommandRequestSchema = Type.Object({
  command: Type.String(),
  cwd: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
});

export const StartBashCommandResponseSchema = Type.Object({
  id: Type.String(),
});

export const BashOutputEventSchema = Type.Object({
  kind: Type.Literal("BashOutput"),
  id: Type.String(),
  timestamp: Type.String(),
  command_id: Type.String(),
  stdout: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
  exit_code: Type.Union([Type.Number(), Type.Null()]),
});

export const BashEventPageSchema = Type.Object({
  items: Type.Array(BashOutputEventSchema),
  next_page_id: Type.Optional(Type.String()),
});

export const GitChangeStatusSchema = Type.Union([
  Type.Literal("MOVED"),
  Type.Literal("ADDED"),
  Type.Literal("DELETED"),
  Type.Literal("UPDATED"),
]);

export const GitChangeSchema = Type.Object({
  status: GitChangeStatusSchema,
  path: Type.String(),
});

export const GitChangesSchema = Type.Array(GitChangeSchema);

export const GitDiffSchema = Type.Object({
  modified: Type.String(),
  original: Type.String(),
});

export const GitPathQuerySchema = Type.Object({
  path: Type.String(),
});

export const ConversationIdParamsSchema = Type.Object({
  conversationId: Type.String(),
});

export const ConversationEventIdParamsSchema = Type.Object({
  conversationId: Type.String(),
  eventId: Type.String(),
});

export const SocketsEventsQuerySchema = Type.Object({
  resend_all: Type.Optional(Type.String()),
  session_api_key: Type.Optional(Type.String()),
});

export const GenerateTitleRequestSchema = Type.Object({
  max_length: Type.Optional(Type.Number()),
  llm: Type.Optional(Type.Union([LlmSchema, Type.Null()])),
});

export const GenerateTitleResponseSchema = Type.Object({ title: Type.String() });

export const ConfirmationResponseSchema = Type.Object({
  accept: Type.Boolean(),
  reason: Type.Optional(Type.String()),
});

export const SetSecretsRequestSchema = Type.Object({
  secrets: Type.Record(Type.String(), SecretValueSchema),
});

export const SetConfirmationPolicyRequestSchema = Type.Object({
  policy: ConfirmationPolicySchema,
});

export const SetSecurityAnalyzerRequestSchema = Type.Object({
  security_analyzer: Type.Optional(RemoteSecurityAnalyzerSchema),
});

export const RunRequestSchema = SmolpawsRunnerRequestSchema;
export const RunResponseSchema = SmolpawsRunnerResponseSchema;

export const ServerInfoSchema = Type.Object({
  uptime: Type.Number(),
  idle_time: Type.Number(),
  title: Type.String(),
  version: Type.String(),
  docs: Type.String(),
  redoc: Type.String(),
});

export type StartConversationRequest = Static<typeof StartConversationRequestSchema>;
export type ConversationInfo = Static<typeof ConversationInfoSchema>;
export type ConversationPage = Static<typeof ConversationPageSchema>;
export type ConversationBatch = Static<typeof ConversationBatchSchema>;
export type EventPage = Static<typeof EventPageSchema>;
export type EventBatch = Static<typeof EventBatchSchema>;
export type RunRequest = Static<typeof RunRequestSchema>;
export type RunResponse = Static<typeof RunResponseSchema>;
export type ConversationList = Static<typeof ConversationListSchema>;
export type StartBashCommandRequest = Static<typeof StartBashCommandRequestSchema>;
export type StartBashCommandResponse = Static<typeof StartBashCommandResponseSchema>;
export type BashOutputEvent = Static<typeof BashOutputEventSchema>;
export type BashEventPage = Static<typeof BashEventPageSchema>;
export type GitChange = Static<typeof GitChangeSchema>;
export type GitDiff = Static<typeof GitDiffSchema>;
export type GitPathQuery = Static<typeof GitPathQuerySchema>;
export type ConversationIdParams = Static<typeof ConversationIdParamsSchema>;
export type SocketsEventsQuery = Static<typeof SocketsEventsQuerySchema>;
export type ErrorResponse = Static<typeof ErrorSchema>;
export type AskAgentRequest = Static<typeof AskAgentRequestSchema>;
export type AskAgentResponse = Static<typeof AskAgentResponseSchema>;
export type GenerateTitleRequest = Static<typeof GenerateTitleRequestSchema>;
export type GenerateTitleResponse = Static<typeof GenerateTitleResponseSchema>;
export type ConfirmationResponseRequest = Static<typeof ConfirmationResponseSchema>;
export type SetSecretsRequest = Static<typeof SetSecretsRequestSchema>;
export type SetConfirmationPolicyRequest = Static<typeof SetConfirmationPolicyRequestSchema>;
export type SetSecurityAnalyzerRequest = Static<typeof SetSecurityAnalyzerRequestSchema>;
