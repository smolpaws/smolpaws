export type SmolpawsEvent = "issue_comment" | "pull_request_review_comment";

export type GithubEventPayload = {
  action?: string;
  sender?: { login?: string; id?: number };
  comment?: { body?: string; id?: number };
  repository?: {
    full_name?: string;
    owner?: { login?: string };
  };
  issue?: { number?: number };
  pull_request?: { number?: number };
  installation?: { id?: number };
};

export type SmolpawsIngress = "github_webhook" | "github_notifications";

export type SmolpawsQueueMeta = {
  ingress: SmolpawsIngress;
  notification_thread_id?: string;
};

export type SmolpawsQueueMessage = {
  event: SmolpawsEvent;
  payload: GithubEventPayload;
  delivery_id?: string;
  meta?: SmolpawsQueueMeta;
};
