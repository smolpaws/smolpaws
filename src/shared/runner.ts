export type SmolpawsConversationConfig = {
  ingress?: string;
  scope_id?: string;
  is_control_scope?: boolean;
  enable_send_message?: boolean;
  enable_task_tools?: boolean;
  visible_tasks?: SmolpawsVisibleTask[];
  github?: SmolpawsGithubContext;
};

export type SmolpawsGithubContext = {
  event?: string;
  repository_full_name?: string;
  owner_login?: string;
  actor_login?: string;
  issue_number?: number;
  pull_request_number?: number;
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

export type SmolpawsOutboundMessage = {
  kind: 'current_thread_message';
  text: string;
};
