import { Type, type Static } from '@sinclair/typebox';

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

export const SmolpawsOutboundMessageListSchema = Type.Array(
  SmolpawsOutboundMessageSchema,
);

export const SmolpawsTaskCommandListSchema = Type.Array(
  SmolpawsTaskCommandSchema,
);

export type SmolpawsConversationConfigValue = Static<
  typeof SmolpawsConversationConfigSchema
>;
export type SmolpawsOutboundMessage = Static<typeof SmolpawsOutboundMessageSchema>;
export type SmolpawsTaskCommandValue = Static<typeof SmolpawsTaskCommandSchema>;
