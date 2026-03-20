import { Type, type Static } from '@sinclair/typebox';
import type { GithubEventPayload, SmolpawsEvent } from './github.js';

export type SmolpawsRunnerGithubContext = {
  event: SmolpawsEvent;
  payload: GithubEventPayload;
  token?: string;
};

export type SmolpawsConversationConfig = {
  ingress?: string;
  scope_id?: string;
  is_control_scope?: boolean;
  enable_send_message?: boolean;
  enable_task_tools?: boolean;
  visible_tasks?: SmolpawsVisibleTask[];
};

export type SmolpawsVisibleTask = {
  id: string;
  scope_id?: string;
  group_folder?: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: string;
  next_run?: string | null;
};

export type SmolpawsTaskCommand =
  | {
      kind: 'schedule_task';
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode: 'group' | 'isolated';
      target_scope_id?: string;
      source_scope_id?: string;
    }
  | {
      kind: 'pause_task' | 'resume_task' | 'cancel_task';
      task_id: string;
      source_scope_id?: string;
    };

export type SmolpawsRunnerRequest = {
  prompt: string;
  fallback_reply?: string;
  delivery_id?: string;
  ingress?: string;
  github?: SmolpawsRunnerGithubContext;
};

export const SmolpawsRunnerGithubContextSchema = Type.Object({
  event: Type.Union([
    Type.Literal('issue_comment'),
    Type.Literal('pull_request_review_comment'),
  ]),
  payload: Type.Any(),
  token: Type.Optional(Type.String()),
});

export const SmolpawsOutboundMessageSchema = Type.Object({
  kind: Type.Literal('current_thread_message'),
  text: Type.String(),
});

export const SmolpawsVisibleTaskSchema = Type.Object({
  id: Type.String(),
  scope_id: Type.Optional(Type.String()),
  group_folder: Type.Optional(Type.String()),
  prompt: Type.String(),
  schedule_type: Type.Union([
    Type.Literal('cron'),
    Type.Literal('interval'),
    Type.Literal('once'),
  ]),
  schedule_value: Type.String(),
  status: Type.String(),
  next_run: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const SmolpawsTaskCommandSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('schedule_task'),
    prompt: Type.String(),
    schedule_type: Type.Union([
      Type.Literal('cron'),
      Type.Literal('interval'),
      Type.Literal('once'),
    ]),
    schedule_value: Type.String(),
    context_mode: Type.Union([Type.Literal('group'), Type.Literal('isolated')]),
    target_scope_id: Type.Optional(Type.String()),
    source_scope_id: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Union([
      Type.Literal('pause_task'),
      Type.Literal('resume_task'),
      Type.Literal('cancel_task'),
    ]),
    task_id: Type.String(),
    source_scope_id: Type.Optional(Type.String()),
  }),
]);

export const SmolpawsConversationConfigSchema = Type.Object({
  ingress: Type.Optional(Type.String()),
  scope_id: Type.Optional(Type.String()),
  is_control_scope: Type.Optional(Type.Boolean()),
  enable_send_message: Type.Optional(Type.Boolean()),
  enable_task_tools: Type.Optional(Type.Boolean()),
  visible_tasks: Type.Optional(Type.Array(SmolpawsVisibleTaskSchema)),
});

export const SmolpawsRunnerRequestSchema = Type.Object({
  prompt: Type.String(),
  fallback_reply: Type.Optional(Type.String()),
  delivery_id: Type.Optional(Type.String()),
  ingress: Type.Optional(Type.String()),
  github: Type.Optional(SmolpawsRunnerGithubContextSchema),
});

export const SmolpawsOutboundMessageListSchema = Type.Array(
  SmolpawsOutboundMessageSchema,
);

export const SmolpawsTaskCommandListSchema = Type.Array(
  SmolpawsTaskCommandSchema,
);

export const SmolpawsRunnerResponseSchema = Type.Object({
  reply: Type.String(),
  outbound_messages: Type.Optional(Type.Array(SmolpawsOutboundMessageSchema)),
});

export type SmolpawsConversationConfigValue = Static<
  typeof SmolpawsConversationConfigSchema
>;
export type SmolpawsOutboundMessage = Static<typeof SmolpawsOutboundMessageSchema>;
export type SmolpawsTaskCommandValue = Static<typeof SmolpawsTaskCommandSchema>;
export type SmolpawsRunnerResponse = Static<typeof SmolpawsRunnerResponseSchema>;
export type SmolpawsRunnerRequestBody = Static<typeof SmolpawsRunnerRequestSchema>;
