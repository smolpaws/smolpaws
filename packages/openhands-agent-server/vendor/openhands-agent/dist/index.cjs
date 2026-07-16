'use strict';

var crypto = require('crypto');
var zod = require('zod');
var child_process = require('child_process');
var util = require('util');
var promises = require('fs/promises');
var path2 = require('path');
var fs = require('fs');
var os = require('os');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var path2__default = /*#__PURE__*/_interopDefault(path2);

// src/event/index.ts
var OPENHANDS_KEYRING_SERVICE = "openhands";
var secretRefSchema = zod.z.object({
  service: zod.z.string().min(1).default(OPENHANDS_KEYRING_SERVICE),
  account: zod.z.string().min(1)
}).strict();
var execFileAsync = util.promisify(child_process.execFile);
function llmProviderSecretRef(providerId) {
  return secretRefSchema.parse({ account: `llm-provider:${providerId}` });
}
function llmProfileSecretRef(profileId) {
  return secretRefSchema.parse({ account: `llm-profile:${profileId}:api-key` });
}
async function resolveLlmApiKeyRef(lookup, store) {
  if (lookup.useProfileKeyOverride === true && lookup.profileId !== void 0) {
    const profileRef = llmProfileSecretRef(lookup.profileId);
    if (await store.has(profileRef)) {
      return profileRef;
    }
  }
  const providerRef = llmProviderSecretRef(lookup.providerId);
  return await store.has(providerRef) ? providerRef : null;
}
async function getLlmApiKey(lookup, store) {
  const ref = await resolveLlmApiKeyRef(lookup, store);
  return ref === null ? null : store.get(ref);
}
var InMemorySecretStore = class {
  secrets = /* @__PURE__ */ new Map();
  constructor(entries = []) {
    for (const [ref, value] of entries) {
      this.secrets.set(secretKey(ref), value);
    }
  }
  get(ref) {
    return Promise.resolve(this.secrets.get(secretKey(ref)) ?? null);
  }
  set(ref, value) {
    this.secrets.set(secretKey(ref), value);
    return Promise.resolve();
  }
  delete(ref) {
    this.secrets.delete(secretKey(ref));
    return Promise.resolve();
  }
  has(ref) {
    return Promise.resolve(this.secrets.has(secretKey(ref)));
  }
};
var MacOSKeychainSecretStore = class {
  async get(ref) {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        ref.service,
        "-a",
        ref.account,
        "-w"
      ]);
      return trimOneTrailingNewline(stdout);
    } catch (error) {
      if (isMissingKeychainItemError(error)) {
        return null;
      }
      throw error;
    }
  }
  async set(ref, value) {
    await execFileAsync("security", [
      "add-generic-password",
      "-s",
      ref.service,
      "-a",
      ref.account,
      "-w",
      value,
      "-U"
    ]);
  }
  async delete(ref) {
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", ref.service, "-a", ref.account]);
    } catch (error) {
      if (!isMissingKeychainItemError(error)) {
        throw error;
      }
    }
  }
  async has(ref) {
    return await this.get(ref) !== null;
  }
};
function secretKey(ref) {
  return `${ref.service}\0${ref.account}`;
}
function trimOneTrailingNewline(value) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}
function isMissingKeychainItemError(error) {
  return isExecError(error) && (error.code === 44 || error.stderr.includes("could not be found"));
}
function isExecError(error) {
  return typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string";
}

// src/llm/index.ts
var LLM_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
var llmProfileIdSchema = zod.z.string().regex(LLM_PROFILE_ID_PATTERN);
var llmProviderIdSchema = zod.z.string().min(1).regex(/^[A-Za-z0-9._-]+$/u);
var openAiApiModeSchema = zod.z.union([zod.z.literal("chat_completions"), zod.z.literal("responses")]);
var reasoningEffortSchema = zod.z.union([zod.z.literal("low"), zod.z.literal("medium"), zod.z.literal("high")]);
var reasoningSummarySchema = zod.z.union([zod.z.literal("auto"), zod.z.literal("concise"), zod.z.literal("detailed")]);
var promptCacheRetentionSchema = zod.z.union([zod.z.literal("24h"), zod.z.literal("disabled")]);
var llmProfileSchema = zod.z.object({
  profileId: llmProfileIdSchema,
  providerId: llmProviderIdSchema,
  model: zod.z.string().min(1),
  baseUrl: zod.z.string().url().nullable().default(null),
  openAiApiMode: openAiApiModeSchema.default("chat_completions"),
  temperature: zod.z.number().min(0).nullable().default(null),
  topP: zod.z.number().min(0).max(1).nullable().default(null),
  topK: zod.z.number().int().positive().nullable().default(null),
  maxInputTokens: zod.z.number().int().positive().nullable().default(null),
  maxOutputTokens: zod.z.number().int().positive().nullable().default(null),
  timeoutSeconds: zod.z.number().positive().nullable().default(null),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  reasoningSummary: reasoningSummarySchema.nullable().default(null),
  promptCacheRetention: promptCacheRetentionSchema.nullable().default(null),
  promptCacheKey: zod.z.string().min(1).nullable().default(null),
  headers: zod.z.record(zod.z.string(), zod.z.string()).default({}),
  useProfileKeyOverride: zod.z.boolean().default(false)
}).strict();
function resolveLlmProfileApiKeyRef(profile, store) {
  return resolveLlmApiKeyRef(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride
    },
    store
  );
}
var thinkingBlockSchema = zod.z.object({
  type: zod.z.literal("thinking").default("thinking"),
  thinking: zod.z.string(),
  signature: zod.z.string().nullable().default(null)
}).strict();
var redactedThinkingBlockSchema = zod.z.object({
  type: zod.z.literal("redacted_thinking").default("redacted_thinking"),
  data: zod.z.string()
}).strict();
var reasoningItemSchema = zod.z.object({
  id: zod.z.string().nullable().default(null),
  summary: zod.z.array(zod.z.string()).default([]),
  content: zod.z.array(zod.z.string()).nullable().default(null),
  encrypted_content: zod.z.string().nullable().default(null),
  status: zod.z.string().nullable().default(null)
}).strict();
var baseContentSchema = zod.z.object({
  cache_prompt: zod.z.boolean().default(false),
  enable_truncation: zod.z.boolean().optional()
});
var textContentSchema = baseContentSchema.extend({
  type: zod.z.literal("text").default("text"),
  text: zod.z.string()
}).strict().transform(({ cache_prompt, type, text }) => ({ cache_prompt, type, text }));
var imageContentSchema = baseContentSchema.extend({
  type: zod.z.literal("image").default("image"),
  image_urls: zod.z.array(zod.z.string())
}).strict().transform(({ cache_prompt, type, image_urls }) => ({ cache_prompt, type, image_urls }));
var contentSchema = zod.z.union([textContentSchema, imageContentSchema]);
var messageToolCallSchema = zod.z.object({
  id: zod.z.string(),
  responses_item_id: zod.z.string().nullable().default(null),
  name: zod.z.string(),
  arguments: zod.z.string(),
  origin: zod.z.union([zod.z.literal("completion"), zod.z.literal("responses")])
}).strict();
var rawMessageSchema = zod.z.object({
  role: zod.z.union([zod.z.literal("user"), zod.z.literal("system"), zod.z.literal("assistant"), zod.z.literal("tool")]),
  content: zod.z.union([zod.z.string(), zod.z.array(contentSchema), zod.z.null()]).default([]).transform((content) => {
    if (content === null) {
      return [];
    }
    if (typeof content === "string") {
      return [textContent(content)];
    }
    return content;
  }),
  tool_calls: zod.z.array(messageToolCallSchema).nullable().default(null),
  tool_call_id: zod.z.string().nullable().default(null),
  name: zod.z.string().nullable().default(null),
  cache_enabled: zod.z.boolean().optional(),
  vision_enabled: zod.z.boolean().optional(),
  function_calling_enabled: zod.z.boolean().optional(),
  force_string_serializer: zod.z.boolean().optional(),
  send_reasoning_content: zod.z.boolean().optional(),
  reasoning_content: zod.z.string().nullable().default(null),
  thinking_blocks: zod.z.array(zod.z.union([thinkingBlockSchema, redactedThinkingBlockSchema])).default([]),
  responses_reasoning_item: reasoningItemSchema.nullable().default(null)
}).strict();
var messageSchema = rawMessageSchema.transform((message) => ({
  role: message.role,
  content: message.content,
  tool_calls: message.tool_calls,
  tool_call_id: message.tool_call_id,
  name: message.name,
  reasoning_content: message.reasoning_content,
  thinking_blocks: message.thinking_blocks,
  responses_reasoning_item: message.responses_reasoning_item
}));
function textContent(text, cachePrompt = false) {
  return textContentSchema.parse({ text, cache_prompt: cachePrompt });
}
function imageContent(imageUrls, cachePrompt = false) {
  return imageContentSchema.parse({ image_urls: [...imageUrls], cache_prompt: cachePrompt });
}
function reduceTextContent(message) {
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
function contentToString(content) {
  return content.map((item) => item.type === "text" ? item.text : `[Image: ${item.image_urls.length} URLs]`);
}

// src/event/index.ts
var N_CHAR_PREVIEW = 500;
var FULL_STATE_KEY = "full_state";
var sourceTypeSchema = zod.z.union([
  zod.z.literal("agent"),
  zod.z.literal("user"),
  zod.z.literal("environment"),
  zod.z.literal("hook")
]);
var recordSchema = zod.z.record(zod.z.string(), zod.z.unknown());
var baseEventFields = {
  id: zod.z.string().default(() => crypto.randomUUID()),
  timestamp: zod.z.string().default(() => (/* @__PURE__ */ new Date()).toISOString()),
  source: sourceTypeSchema
};
function eventObject(shape) {
  return zod.z.object({ ...baseEventFields, ...shape }).strict();
}
var tokenEventSchema = eventObject({
  kind: zod.z.literal("TokenEvent").default("TokenEvent"),
  prompt_token_ids: zod.z.array(zod.z.number().int()),
  response_token_ids: zod.z.array(zod.z.number().int())
});
var streamingDeltaEventSchema = eventObject({
  kind: zod.z.literal("StreamingDeltaEvent").default("StreamingDeltaEvent"),
  source: zod.z.literal("agent").default("agent"),
  content: zod.z.string().nullable().default(null),
  reasoning_content: zod.z.string().nullable().default(null)
});
var conversationErrorEventSchema = eventObject({
  kind: zod.z.literal("ConversationErrorEvent").default("ConversationErrorEvent"),
  code: zod.z.string(),
  detail: zod.z.string()
});
var llmCompletionLogEventSchema = eventObject({
  kind: zod.z.literal("LLMCompletionLogEvent").default("LLMCompletionLogEvent"),
  source: zod.z.literal("environment").default("environment"),
  filename: zod.z.string(),
  log_data: zod.z.string(),
  model_name: zod.z.string().default("unknown"),
  usage_id: zod.z.string().default("default")
});
var pauseEventSchema = eventObject({
  kind: zod.z.literal("PauseEvent").default("PauseEvent"),
  source: zod.z.literal("user").default("user")
});
var interruptEventSchema = eventObject({
  kind: zod.z.literal("InterruptEvent").default("InterruptEvent"),
  source: zod.z.literal("user").default("user")
});
var conversationStateUpdateEventSchema = eventObject({
  kind: zod.z.literal("ConversationStateUpdateEvent").default("ConversationStateUpdateEvent"),
  source: zod.z.literal("environment").default("environment"),
  key: zod.z.string().default(() => crypto.randomUUID()),
  value: zod.z.unknown().default({})
});
var systemPromptEventSchema = eventObject({
  kind: zod.z.literal("SystemPromptEvent").default("SystemPromptEvent"),
  source: zod.z.literal("agent").default("agent"),
  system_prompt: contentSchema.refine((content) => content.type === "text", "system_prompt must be text"),
  tools: zod.z.array(recordSchema),
  dynamic_context: contentSchema.refine((content) => content.type === "text", "dynamic_context must be text").nullable().default(null)
});
var messageEventSchema = eventObject({
  kind: zod.z.literal("MessageEvent").default("MessageEvent"),
  llm_message: messageSchema,
  llm_response_id: zod.z.string().nullable().default(null),
  activated_skills: zod.z.array(zod.z.string()).default([]),
  extended_content: zod.z.array(contentSchema).default([]),
  sender: zod.z.string().nullable().default(null),
  critic_result: zod.z.unknown().nullable().default(null)
});
var actionEventSchema = eventObject({
  kind: zod.z.literal("ActionEvent").default("ActionEvent"),
  source: zod.z.literal("agent").default("agent"),
  thought: zod.z.array(contentSchema).default([]),
  action: recordSchema,
  tool_name: zod.z.string(),
  tool_call_id: zod.z.string(),
  tool_call: messageToolCallSchema,
  llm_response_id: zod.z.string().nullable().default(null),
  reasoning_content: zod.z.string().nullable().default(null),
  thinking_blocks: zod.z.array(zod.z.union([thinkingBlockSchema, redactedThinkingBlockSchema])).default([]),
  responses_reasoning_item: reasoningItemSchema.nullable().default(null)
});
var observationEventSchema = eventObject({
  kind: zod.z.literal("ObservationEvent").default("ObservationEvent"),
  source: zod.z.literal("environment").default("environment"),
  observation: recordSchema,
  action_id: zod.z.string(),
  tool_name: zod.z.string(),
  tool_call_id: zod.z.string()
});
var userRejectObservationSchema = eventObject({
  kind: zod.z.literal("UserRejectObservation").default("UserRejectObservation"),
  source: zod.z.literal("environment").default("environment"),
  tool_name: zod.z.string(),
  tool_call_id: zod.z.string(),
  rejection_reason: zod.z.string().default("User rejected the action"),
  rejection_source: zod.z.union([zod.z.literal("user"), zod.z.literal("hook")]).default("user"),
  action_id: zod.z.string()
});
var agentErrorEventSchema = eventObject({
  kind: zod.z.literal("AgentErrorEvent").default("AgentErrorEvent"),
  source: zod.z.literal("agent").default("agent"),
  tool_name: zod.z.string(),
  tool_call_id: zod.z.string(),
  error: zod.z.string()
});
var condensationSchema = eventObject({
  kind: zod.z.literal("Condensation").default("Condensation"),
  source: zod.z.literal("environment").default("environment"),
  summary: zod.z.string().nullable().default(null),
  summary_offset: zod.z.number().int().min(0).nullable().default(null),
  forgotten_event_ids: zod.z.union([zod.z.set(zod.z.string()), zod.z.array(zod.z.string())]).transform((ids) => ids instanceof Set ? ids : new Set(ids)),
  llm_response_id: zod.z.string().nullable().default(null)
});
var condensationRequestSchema = eventObject({
  kind: zod.z.literal("CondensationRequest").default("CondensationRequest"),
  source: zod.z.literal("environment").default("environment")
});
var condensationSummaryEventSchema = eventObject({
  kind: zod.z.literal("CondensationSummaryEvent").default("CondensationSummaryEvent"),
  source: zod.z.literal("environment").default("environment"),
  summary: zod.z.string()
});
var acpToolCallEventSchema = eventObject({
  kind: zod.z.literal("ACPToolCallEvent").default("ACPToolCallEvent"),
  source: zod.z.literal("agent").default("agent"),
  tool_call_id: zod.z.string(),
  title: zod.z.string(),
  status: zod.z.string().nullable().default(null),
  tool_kind: zod.z.string().nullable().default(null),
  raw_input: zod.z.unknown().nullable().default(null),
  raw_output: zod.z.unknown().nullable().default(null),
  content: zod.z.array(zod.z.unknown()).nullable().default(null),
  is_error: zod.z.boolean().default(false)
});
var hookEventTypeSchema = zod.z.union([
  zod.z.literal("PreToolUse"),
  zod.z.literal("PostToolUse"),
  zod.z.literal("UserPromptSubmit"),
  zod.z.literal("SessionStart"),
  zod.z.literal("SessionEnd"),
  zod.z.literal("Stop")
]);
var hookExecutionEventSchema = eventObject({
  kind: zod.z.literal("HookExecutionEvent").default("HookExecutionEvent"),
  source: zod.z.literal("hook").default("hook"),
  hook_event_type: hookEventTypeSchema,
  hook_command: zod.z.string(),
  tool_name: zod.z.string().nullable().default(null),
  success: zod.z.boolean(),
  blocked: zod.z.boolean().default(false),
  exit_code: zod.z.number().int(),
  stdout: zod.z.string().default(""),
  stderr: zod.z.string().default(""),
  reason: zod.z.string().nullable().default(null),
  additional_context: zod.z.string().nullable().default(null),
  error: zod.z.string().nullable().default(null),
  action_id: zod.z.string().nullable().default(null),
  message_id: zod.z.string().nullable().default(null),
  hook_input: recordSchema.nullable().default(null)
});
var resumeTranscriptEventSchema = eventObject({
  kind: zod.z.literal("ResumeTranscriptEvent").default("ResumeTranscriptEvent"),
  source: zod.z.literal("environment").default("environment"),
  transcript: zod.z.array(recordSchema).default([])
});
var eventSchema = zod.z.discriminatedUnion("kind", [
  tokenEventSchema,
  streamingDeltaEventSchema,
  conversationErrorEventSchema,
  llmCompletionLogEventSchema,
  pauseEventSchema,
  interruptEventSchema,
  conversationStateUpdateEventSchema,
  systemPromptEventSchema,
  messageEventSchema,
  actionEventSchema,
  observationEventSchema,
  userRejectObservationSchema,
  agentErrorEventSchema,
  condensationSchema,
  condensationRequestSchema,
  condensationSummaryEventSchema,
  acpToolCallEventSchema,
  hookExecutionEventSchema,
  resumeTranscriptEventSchema
]);
var llmConvertibleEventSchema = zod.z.discriminatedUnion("kind", [
  systemPromptEventSchema,
  messageEventSchema,
  actionEventSchema,
  observationEventSchema,
  userRejectObservationSchema,
  agentErrorEventSchema,
  condensationSummaryEventSchema
]);
function isMessageEvent(event) {
  return eventKind(event) === "MessageEvent";
}
function isConversationStateUpdateEvent(event) {
  return eventKind(event) === "ConversationStateUpdateEvent";
}
function eventKind(event) {
  if (!isRecord(event)) {
    return void 0;
  }
  return typeof event.kind === "string" ? event.kind : void 0;
}
function isAcpPatchEdit(event) {
  const diffBlocks = (event.content ?? []).filter((block) => blockField(block, "type") === "diff");
  if (diffBlocks.length > 0) {
    return diffBlocks.some((block) => blockField(block, "old_text", "oldText") !== null);
  }
  const rawInput = event.raw_input;
  if (!isRecord(rawInput)) {
    return false;
  }
  const oldString = rawInput.old_string;
  return typeof oldString === "string" && oldString.length > 0;
}
function blockField(block, ...names) {
  if (!isRecord(block)) {
    return null;
  }
  for (const name of names) {
    if (Object.hasOwn(block, name)) {
      return block[name];
    }
  }
  return null;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toLLMMessage(event) {
  switch (event.kind) {
    case "SystemPromptEvent":
      return {
        role: "system",
        content: event.dynamic_context === null ? [event.system_prompt] : [event.system_prompt, event.dynamic_context],
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null
      };
    case "MessageEvent":
      return {
        ...event.llm_message,
        content: [...event.llm_message.content, ...event.extended_content]
      };
    case "ActionEvent":
      return {
        role: "assistant",
        content: event.thought,
        tool_calls: [event.tool_call],
        tool_call_id: null,
        name: null,
        reasoning_content: event.reasoning_content,
        thinking_blocks: event.thinking_blocks,
        responses_reasoning_item: event.responses_reasoning_item
      };
    case "ObservationEvent":
      return toolMessage(event.tool_name, event.tool_call_id, observationContent(event.observation));
    case "UserRejectObservation":
      return toolMessage(event.tool_name, event.tool_call_id, [textContent(`Action rejected: ${event.rejection_reason}`)]);
    case "AgentErrorEvent":
      return toolMessage(event.tool_name, event.tool_call_id, [textContent(event.error)]);
    case "CondensationSummaryEvent":
      return {
        role: "user",
        content: [textContent(event.summary)],
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null
      };
  }
}
function eventsToMessages(events) {
  const messages = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (event === void 0) {
      break;
    }
    let message;
    if (event.kind === "ActionEvent") {
      const batch = [event];
      const responseId = event.llm_response_id;
      let j = i + 1;
      while (j < events.length) {
        const next = events[j];
        if (next?.kind !== "ActionEvent" || next.llm_response_id !== responseId) {
          break;
        }
        batch.push(next);
        j += 1;
      }
      message = combineActionEvents(batch);
      i = j;
    } else {
      message = toLLMMessage(event);
      i += 1;
    }
    const previous = messages.at(-1);
    if (previous !== void 0 && canMergeUserMessages(previous, message)) {
      previous.content = [...previous.content, ...message.content];
    } else {
      messages.push(message);
    }
  }
  return messages;
}
function combineActionEvents(events) {
  if (events.length === 1) {
    return toLLMMessage(events[0]);
  }
  const [first, ...rest] = events;
  for (const event of rest) {
    if (event.thought.length !== 0) {
      throw new Error("Expected empty thought for multi-action events after the first one");
    }
  }
  return {
    role: "assistant",
    content: first.thought,
    tool_calls: events.map((event) => event.tool_call),
    tool_call_id: null,
    name: null,
    reasoning_content: first.reasoning_content,
    thinking_blocks: first.thinking_blocks,
    responses_reasoning_item: first.responses_reasoning_item
  };
}
function toolMessage(name, toolCallId, content) {
  return {
    role: "tool",
    content: [...content],
    tool_calls: null,
    tool_call_id: toolCallId,
    name,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null
  };
}
function observationContent(observation) {
  const toLlmContent = observation.to_llm_content;
  if (Array.isArray(toLlmContent)) {
    return zod.z.array(contentSchema).parse(toLlmContent);
  }
  const content = observation.content;
  if (Array.isArray(content)) {
    return zod.z.array(contentSchema).parse(content);
  }
  return [textContent(JSON.stringify(observation))];
}
function isPlainUserMessage(message) {
  return message.role === "user" && message.tool_calls === null && message.tool_call_id === null && message.name === null;
}
function canMergeUserMessages(previous, current) {
  return isPlainUserMessage(previous) && isPlainUserMessage(current);
}
var keywordTriggerSchema = zod.z.object({ type: zod.z.literal("keyword").default("keyword"), keywords: zod.z.array(zod.z.string()) }).strict();
var taskTriggerSchema = zod.z.object({ type: zod.z.literal("task").default("task"), triggers: zod.z.array(zod.z.string()) }).strict();
var triggerSchema = zod.z.discriminatedUnion("type", [keywordTriggerSchema, taskTriggerSchema]);
var inputMetadataSchema = zod.z.object({ name: zod.z.string(), description: zod.z.string() }).strict();
var skillResourcesSchema = zod.z.object({ skillRoot: zod.z.string(), scripts: zod.z.array(zod.z.string()).default([]), references: zod.z.array(zod.z.string()).default([]), assets: zod.z.array(zod.z.string()).default([]) }).strict();
var skillDataSchema = zod.z.object({
  name: zod.z.string().min(1),
  content: zod.z.string(),
  trigger: triggerSchema.nullable().default(null),
  source: zod.z.string().nullable().default(null),
  mcpTools: zod.z.record(zod.z.string(), zod.z.unknown()).nullable().default(null),
  inputs: zod.z.array(inputMetadataSchema).default([]),
  isAgentskillsFormat: zod.z.boolean().default(false),
  version: zod.z.string().default("1.0.0"),
  description: zod.z.string().nullable().default(null),
  license: zod.z.string().nullable().default(null),
  compatibility: zod.z.string().nullable().default(null),
  metadata: zod.z.record(zod.z.string(), zod.z.string()).nullable().default(null),
  allowedTools: zod.z.array(zod.z.string()).nullable().default(null),
  disableModelInvocation: zod.z.boolean().default(false),
  resources: skillResourcesSchema.nullable().default(null)
}).strict();
var Skill = class {
  name;
  content;
  trigger;
  source;
  mcpTools;
  inputs;
  isAgentskillsFormat;
  version;
  description;
  license;
  compatibility;
  metadata;
  allowedTools;
  disableModelInvocation;
  resources;
  constructor(data) {
    this.name = data.name;
    this.content = data.content;
    this.trigger = data.trigger;
    this.source = data.source;
    this.mcpTools = data.mcpTools;
    this.inputs = data.inputs;
    this.isAgentskillsFormat = data.isAgentskillsFormat;
    this.version = data.version;
    this.description = data.description;
    this.license = data.license;
    this.compatibility = data.compatibility;
    this.metadata = data.metadata;
    this.allowedTools = data.allowedTools;
    this.disableModelInvocation = data.disableModelInvocation;
    this.resources = data.resources;
  }
  static async load(path3, skillBaseDir, strict = true) {
    const fileContent = await promises.readFile(path3, "utf8");
    if (path2.basename(path3).toLowerCase() === "skill.md") {
      return loadAgentSkill(path3, fileContent, strict);
    }
    return loadLegacySkill(path3, fileContent, skillBaseDir);
  }
  matchTrigger(message) {
    if (this.trigger === null) {
      return null;
    }
    const messageLower = message.toLowerCase();
    const candidates = this.trigger.type === "keyword" ? this.trigger.keywords : this.trigger.triggers;
    return candidates.find((candidate) => messageLower.includes(candidate.toLowerCase())) ?? null;
  }
  getTriggers() {
    if (this.trigger === null) {
      return [];
    }
    return this.trigger.type === "keyword" ? [...this.trigger.keywords] : [...this.trigger.triggers];
  }
  getSkillType() {
    if (this.isAgentskillsFormat) {
      return "agentskills";
    }
    return this.trigger === null ? "repo" : "knowledge";
  }
  requiresUserInput() {
    return extractVariables(this.content).length > 0;
  }
};
var skillSchema = skillDataSchema.transform((data) => new Skill(data));
async function loadSkillsFromDir(skillDir) {
  const loaded = { repoSkills: {}, knowledgeSkills: {}, agentSkills: {} };
  if (!await existsDirectory(skillDir)) {
    return loaded;
  }
  const entries = await promises.readdir(skillDir, { withFileTypes: true });
  const skillMdDirectories = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path2.join(skillDir, entry.name, "SKILL.md");
    if (await existsFile(skillPath)) {
      skillMdDirectories.add(entry.name);
      categorizeSkill(await Skill.load(skillPath, skillDir), loaded);
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || path2.extname(entry.name).toLowerCase() !== ".md") {
      continue;
    }
    if (skillMdDirectories.has(entry.name)) {
      continue;
    }
    categorizeSkill(await Skill.load(path2.join(skillDir, entry.name), skillDir), loaded);
  }
  return loaded;
}
function mergeSkillsByName(primary, secondary) {
  const merged = [...primary];
  const seen = new Set(merged.map((skill) => skill.name));
  for (const skill of secondary) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  return merged;
}
function skillsToPrompt(skills, maxDescriptionLength = 1024) {
  if (skills.length === 0) {
    return "<available_skills>\n  no available skills\n</available_skills>";
  }
  const lines = ["<available_skills>"];
  for (const skill of skills) {
    const { description, truncated } = skillDescription(skill, maxDescriptionLength);
    const suffix = truncated > 0 ? `... [${truncated} characters truncated. Call invoke_skill(name=${JSON.stringify(skill.name)}) to load the full skill]` : "";
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name.trim())}</name>`);
    lines.push(`    <description>${escapeXml(`${description}${suffix}`.trim())}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
async function loadAgentSkill(path3, fileContent, strict) {
  const parsed = parseFrontmatter(fileContent);
  const directoryName = path2.basename(path2.dirname(path3));
  const name = stringValue(parsed.metadata.name) ?? directoryName;
  if (strict && !isValidAgentSkillName(name)) {
    throw new Error(`Invalid skill name '${name}'`);
  }
  const resources = await discoverSkillResources(path2.dirname(path3));
  return createSkillFromMetadata(name, parsed.content, path3, parsed.metadata, resources, true);
}
function loadLegacySkill(path3, fileContent, skillBaseDir) {
  const thirdPartyName = thirdPartySkillName(path2.basename(path3));
  if (thirdPartyName !== null) {
    return skillSchema.parse({ name: thirdPartyName, content: fileContent, source: path3, trigger: null });
  }
  const parsed = parseFrontmatter(fileContent);
  const derivedName = skillBaseDir === void 0 ? path2.basename(path3, path2.extname(path3)) : stripMarkdownExtension(path2.relative(skillBaseDir, path3));
  const name = stringValue(parsed.metadata.name) ?? derivedName;
  return createSkillFromMetadata(name, parsed.content, path3, parsed.metadata, null, false);
}
function createSkillFromMetadata(name, content, source, metadata, resources, isAgentskillsFormat) {
  const triggers = stringList(metadata.triggers);
  const inputs = inputList(metadata.inputs);
  const trigger = inputs.length > 0 ? taskTriggerSchema.parse({ triggers: triggers.includes(`/${name}`) ? triggers : [...triggers, `/${name}`] }) : triggers.length > 0 ? keywordTriggerSchema.parse({ keywords: triggers }) : null;
  const allowedRaw = metadata["allowed-tools"] ?? metadata.allowed_tools;
  return skillSchema.parse({
    name,
    content: appendMissingVariablesPrompt(content, trigger, inputs),
    source,
    trigger,
    inputs,
    isAgentskillsFormat,
    description: stringValue(metadata.description),
    license: stringValue(metadata.license),
    compatibility: stringValue(metadata.compatibility),
    metadata: metadataRecord(metadata.metadata),
    allowedTools: allowedTools(allowedRaw),
    disableModelInvocation: booleanValue(metadata["disable-model-invocation"] ?? metadata.disable_model_invocation) ?? false,
    resources
  });
}
function parseFrontmatter(content) {
  const lines = content.replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10));
  if (lines[0] !== "---") {
    return { metadata: {}, content };
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return { metadata: {}, content };
  }
  return { metadata: parseYamlSubset(lines.slice(1, end)), content: lines.slice(end + 1).join(String.fromCharCode(10)) };
}
function parseYamlSubset(lines) {
  const metadata = {};
  let currentListKey = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && currentListKey !== null) {
      const current = metadata[currentListKey];
      if (Array.isArray(current)) {
        current.push(trimmed.slice(2).trim());
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw.length === 0) {
      metadata[key] = [];
      currentListKey = key;
    } else {
      metadata[key] = parseScalarOrInlineList(raw);
      currentListKey = null;
    }
  }
  return metadata;
}
function parseScalarOrInlineList(raw) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
  }
  return stripQuotes(raw);
}
function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
async function discoverSkillResources(skillRoot) {
  const resources = { skillRoot, scripts: [], references: [], assets: [] };
  for (const name of ["scripts", "references", "assets"]) {
    const directory = path2.join(skillRoot, name);
    if (await existsDirectory(directory)) {
      resources[name] = await listFiles(directory);
    }
  }
  return resources.scripts.length > 0 || resources.references.length > 0 || resources.assets.length > 0 ? resources : null;
}
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await promises.readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = path2.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}
function categorizeSkill(skill, loaded) {
  if (skill.isAgentskillsFormat) {
    loaded.agentSkills[skill.name] = skill;
  } else if (skill.trigger === null) {
    loaded.repoSkills[skill.name] = skill;
  } else {
    loaded.knowledgeSkills[skill.name] = skill;
  }
}
function skillDescription(skill, maxLength) {
  let description = skill.description ?? "";
  let truncated = 0;
  if (description.length === 0) {
    const lines = skill.content.replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10));
    let offset = 0;
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped.length === 0 || stripped.startsWith("#")) {
        offset += line.length + 1;
        continue;
      }
      description = stripped;
      truncated = Math.max(0, skill.content.length - offset - line.length);
      break;
    }
  }
  if (description.length > maxLength) {
    truncated += description.length - maxLength;
    description = description.slice(0, maxLength);
  }
  return { description, truncated };
}
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function extractVariables(content) {
  const names = [];
  let index = 0;
  while (index < content.length) {
    const start = content.indexOf("${", index);
    if (start === -1) {
      return names;
    }
    const end = content.indexOf("}", start + 2);
    if (end === -1) {
      return names;
    }
    const name = content.slice(start + 2, end);
    if (name.length > 0) {
      names.push(name);
    }
    index = end + 1;
  }
  return names;
}
function appendMissingVariablesPrompt(content, trigger, inputs) {
  if (trigger?.type !== "task" || extractVariables(content).length === 0 && inputs.length === 0) {
    return content;
  }
  const prompt = "\n\nIf the user didn't provide any of these variables, ask the user to provide them first before the agent can proceed with the task.";
  return content.includes(prompt) ? content : `${content}${prompt}`;
}
function stripMarkdownExtension(path3) {
  return path3.toLowerCase().endsWith(".md") ? path3.slice(0, -3) : path3;
}
function thirdPartySkillName(name) {
  const lower = name.toLowerCase();
  if (lower === "agents.md" || lower === "agent.md") {
    return "agents";
  }
  if (lower === ".cursorrules") {
    return "cursorrules";
  }
  if (lower === "claude.md") {
    return "claude";
  }
  if (lower === "gemini.md") {
    return "gemini";
  }
  return null;
}
function stringValue(value) {
  return typeof value === "string" ? value : null;
}
function booleanValue(value) {
  return typeof value === "boolean" ? value : null;
}
function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}
function inputList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => inputMetadataSchema.parse(item));
}
function metadataRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, String(nested)]));
}
function allowedTools(value) {
  if (typeof value === "string") {
    return value.split(" ").filter((part) => part.length > 0);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return null;
}
function isValidAgentSkillName(name) {
  if (name.length === 0 || name.length > 64 || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return false;
  }
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isLower && !isDigit && character !== "-") {
      return false;
    }
  }
  return true;
}
async function existsFile(path3) {
  try {
    return (await promises.stat(path3)).isFile();
  } catch {
    return false;
  }
}
async function existsDirectory(path3) {
  try {
    return (await promises.stat(path3)).isDirectory();
  } catch {
    return false;
  }
}

// src/context/agent-context.ts
var AgentContext = class {
  skills;
  systemMessageSuffix;
  userMessageSuffix;
  secrets;
  currentDatetime;
  constructor(options = {}) {
    this.skills = [...options.skills ?? []];
    assertUniqueSkillNames(this.skills);
    this.systemMessageSuffix = options.systemMessageSuffix ?? null;
    this.userMessageSuffix = options.userMessageSuffix ?? null;
    this.secrets = options.secrets ?? null;
    this.currentDatetime = options.currentDatetime ?? /* @__PURE__ */ new Date();
  }
  getSecretInfos(additional = []) {
    const byName = /* @__PURE__ */ new Map();
    if (this.secrets !== null) {
      for (const [name, value] of Object.entries(this.secrets)) {
        byName.set(name, { name, description: typeof value === "object" ? value.description ?? null : null });
      }
    }
    for (const info of additional) {
      byName.set(info.name, info);
    }
    return [...byName.values()];
  }
  getFormattedDatetime() {
    if (this.currentDatetime === null) {
      return null;
    }
    return this.currentDatetime instanceof Date ? this.currentDatetime.toISOString() : this.currentDatetime;
  }
  partitionSkills() {
    const repoSkills = [];
    const availableSkills = [];
    for (const skill of this.skills) {
      if (skill.isAgentskillsFormat || skill.trigger !== null) {
        if (!skill.disableModelInvocation) {
          availableSkills.push(skill);
        }
      } else {
        repoSkills.push(skill);
      }
    }
    return { repoSkills, availableSkills };
  }
  getSystemMessageSuffix(additionalSecretInfos = []) {
    const { repoSkills, availableSkills } = this.partitionSkills();
    const secretInfos = this.getSecretInfos(additionalSecretInfos);
    const datetime = this.getFormattedDatetime();
    const sections = [];
    if (repoSkills.length > 0) {
      sections.push(`<REPO_CONTEXT>
${repoSkills.map((skill) => `[BEGIN context from [${skill.name}]]
${skill.content.trim()}
[END Context]`).join("\n\n")}
</REPO_CONTEXT>`);
    }
    if (this.systemMessageSuffix !== null && this.systemMessageSuffix.trim().length > 0) {
      sections.push(this.systemMessageSuffix.trim());
    }
    if (availableSkills.length > 0) {
      sections.push(skillsToPrompt(availableSkills));
    }
    if (secretInfos.length > 0) {
      sections.push(`<CUSTOM_SECRETS>
${secretInfos.map((secret) => `* **$${secret.name}**${secret.description ? ` - ${secret.description}` : ""}`).join("\n")}
</CUSTOM_SECRETS>`);
    }
    if (datetime !== null) {
      sections.push(`<CURRENT_DATETIME>
${datetime}
</CURRENT_DATETIME>`);
    }
    return sections.length === 0 ? null : sections.join("\n\n");
  }
  getUserMessageSuffix(message, skipSkillNames = []) {
    const suffix = this.userMessageSuffix?.trim() ?? "";
    const query = message.content.filter((content) => content.type === "text").map((content) => content.text).join("\n").trim();
    const skip = new Set(skipSkillNames);
    const activated = [];
    const triggerBySkill = /* @__PURE__ */ new Map();
    if (query.length > 0) {
      for (const skill of this.skills) {
        const trigger = skill.matchTrigger(query);
        if (trigger !== null && !skip.has(skill.name)) {
          activated.push(skill);
          triggerBySkill.set(skill.name, trigger);
        }
      }
    }
    const parts = [];
    if (activated.length > 0) {
      parts.push(`<RECALLED_SKILLS>
${activated.map((skill) => `<skill>
<name>${skill.name}</name>
<trigger>${triggerBySkill.get(skill.name) ?? ""}</trigger>
<content>${skill.content}</content>
${skill.source === null ? "" : `<location>${skill.source}</location>
`}</skill>`).join("\n")}
</RECALLED_SKILLS>`);
    }
    if (suffix.length > 0) {
      parts.push(suffix);
    }
    return parts.length === 0 ? null : { content: textContent(parts.join("\n\n")), activatedSkills: activated.map((skill) => skill.name) };
  }
};
function assertUniqueSkillNames(skills) {
  const seen = /* @__PURE__ */ new Set();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate skill name found: ${skill.name}`);
    }
    seen.add(skill.name);
  }
}

// src/context/condenser.ts
var condensationRequirement = {
  HARD: "hard",
  SOFT: "soft"
};
var NoCondensationAvailableError = class extends Error {
};
var RollingCondenser = class {
  hardContextReset(_view, _agentLlm) {
    return null;
  }
  condense(view, agentLlm) {
    const requirement = this.condensationRequirement(view, agentLlm);
    if (requirement === null) {
      return view;
    }
    try {
      return this.getCondensation(view, agentLlm);
    } catch (error) {
      if (!(error instanceof NoCondensationAvailableError)) {
        throw error;
      }
      if (requirement === condensationRequirement.SOFT) {
        return view;
      }
      const reset = this.hardContextReset(view, agentLlm);
      if (reset !== null) {
        return reset;
      }
      throw error;
    }
  }
};
var NoOpCondenser = class {
  condense(view) {
    return view;
  }
  handlesCondensationRequests() {
    return false;
  }
};
var PipelineCondenser = class {
  condensers;
  constructor(condensers) {
    this.condensers = [...condensers];
  }
  condense(view, agentLlm) {
    let result = view;
    for (const condenser of this.condensers) {
      if (isCondensation(result)) {
        return result;
      }
      result = condenser.condense(result, agentLlm);
    }
    return result;
  }
  handlesCondensationRequests() {
    return this.condensers.some((condenser) => condenser.handlesCondensationRequests?.() === true);
  }
};
function isCondensation(result) {
  return "kind" in result && result.kind === "Condensation";
}

// src/context/view.ts
var View = class _View {
  events;
  unhandledCondensationRequest;
  constructor(events = [], unhandledCondensationRequest = false) {
    this.events = [...events];
    this.unhandledCondensationRequest = unhandledCondensationRequest;
  }
  get length() {
    return this.events.length;
  }
  appendEvent(event) {
    switch (event.kind) {
      case "Condensation":
        this.applyCondensation(event);
        this.unhandledCondensationRequest = false;
        break;
      case "CondensationRequest":
        this.unhandledCondensationRequest = true;
        break;
      case "SystemPromptEvent":
      case "MessageEvent":
      case "ActionEvent":
      case "ObservationEvent":
      case "UserRejectObservation":
      case "AgentErrorEvent":
      case "CondensationSummaryEvent":
        this.events.push(event);
        break;
    }
  }
  static fromEvents(events) {
    const view = new _View();
    for (const event of events) {
      view.appendEvent(event);
    }
    return view;
  }
  applyCondensation(condensation) {
    const output = this.events.filter((event) => !condensation.forgotten_event_ids.has(event.id));
    if (condensation.summary !== null && condensation.summary_offset !== null) {
      output.splice(condensation.summary_offset, 0, condensationSummaryEventSchema.parse({
        id: `${condensation.id}-summary`,
        source: condensation.source,
        summary: condensation.summary
      }));
    }
    this.events.length = 0;
    this.events.push(...output);
  }
};

// src/conversation/event-log.ts
var EVENTS_DIR = "events";
var EVENT_FILE_PATTERN = "event-{idx}-{event_id}.json";
var LOCK_FILE_NAME = ".eventlog.lock";
var LOCK_TIMEOUT_SECONDS = 30;
var eventNamePattern = /^event-(?<idx>\d{5,})-(?<event_id>[0-9a-fA-F-]{8,})\.json$/u;
var DuplicateEventError = class extends Error {
  constructor(eventId, index) {
    super(`Event with ID '${eventId}' already exists at index ${index}`);
    this.name = "DuplicateEventError";
  }
};
var EventLog = class {
  fs;
  dir;
  lockPath;
  idToIndex = /* @__PURE__ */ new Map();
  indexToId = /* @__PURE__ */ new Map();
  eventCache = /* @__PURE__ */ new Map();
  lengthValue;
  constructor(fs, dirPath = EVENTS_DIR) {
    this.fs = fs;
    this.dir = normalizeStoreDir(dirPath);
    this.lockPath = joinStorePath(this.dir, LOCK_FILE_NAME);
    this.lengthValue = this.scanAndBuildIndex();
  }
  get length() {
    return this.lengthValue;
  }
  getIndex(eventId) {
    const index = this.idToIndex.get(eventId);
    if (index === void 0) {
      throw new Error(`Unknown event_id: ${eventId}`);
    }
    return index;
  }
  has(eventId) {
    return this.idToIndex.has(eventId);
  }
  getId(index) {
    const normalized = this.normalizeIndex(index);
    const eventId = this.indexToId.get(normalized);
    if (eventId === void 0) {
      throw new RangeError("Event index out of range");
    }
    return eventId;
  }
  get(index) {
    const normalized = this.normalizeIndex(index);
    const cached = this.eventCache.get(normalized);
    if (cached !== void 0) {
      return cached;
    }
    let filePath = this.pathForIndex(normalized);
    if (filePath === null) {
      this.lengthValue = this.scanAndBuildIndex();
      filePath = this.pathForIndex(normalized);
      if (filePath === null) {
        throw new RangeError("Event index out of range");
      }
    }
    const event = eventSchema.parse(JSON.parse(this.fs.read(filePath)));
    this.eventCache.set(normalized, event);
    return event;
  }
  at(index) {
    try {
      return this.get(index);
    } catch (error) {
      if (error instanceof RangeError) {
        return void 0;
      }
      throw error;
    }
  }
  slice(start, end) {
    return this.toArray().slice(start, end);
  }
  toArray() {
    return [...this];
  }
  refresh() {
    this.syncFromDisk(this.countEventsOnDisk());
  }
  append(event) {
    this.appendMultiple([event]);
  }
  appendMultiple(events) {
    if (events.length === 0) {
      return;
    }
    this.fs.lock(this.lockPath, () => this.writeEventsUnderLock(events), { timeoutSeconds: LOCK_TIMEOUT_SECONDS });
  }
  async appendAsync(event) {
    await this.appendMultipleAsync([event]);
  }
  async appendMultipleAsync(events) {
    if (events.length === 0) {
      return;
    }
    await this.fs.lockAsync(this.lockPath, () => this.writeEventsUnderLock(events), { timeoutSeconds: LOCK_TIMEOUT_SECONDS });
  }
  [Symbol.iterator]() {
    let index = 0;
    return {
      next: () => {
        if (index >= this.lengthValue) {
          return { done: true, value: void 0 };
        }
        const value = this.get(index);
        index += 1;
        return { done: false, value };
      }
    };
  }
  normalizeIndex(index) {
    const normalized = index < 0 ? index + this.lengthValue : index;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= this.lengthValue) {
      throw new RangeError("Event index out of range");
    }
    return normalized;
  }
  countEventsOnDisk() {
    try {
      return this.fs.list(this.dir).filter((filePath) => isEventFileName(posixBasename(filePath))).length;
    } catch {
      return 0;
    }
  }
  syncFromDisk(_diskLength) {
    const existingIndexToId = new Map(this.indexToId);
    this.scanAndBuildIndex();
    for (const [index, eventId] of existingIndexToId) {
      if (!this.indexToId.has(index)) {
        this.indexToId.set(index, eventId);
      }
      if (!this.idToIndex.has(eventId)) {
        this.idToIndex.set(eventId, index);
      }
    }
    this.lengthValue = contiguousIndexLength(this.indexToId);
  }
  writeEventsUnderLock(events) {
    const diskLength = this.countEventsOnDisk();
    if (diskLength > this.lengthValue) {
      this.syncFromDisk(diskLength);
    }
    const batchIds = /* @__PURE__ */ new Map();
    for (const event of events) {
      const existingIndex = this.idToIndex.get(event.id);
      if (existingIndex !== void 0) {
        throw new DuplicateEventError(event.id, existingIndex);
      }
      const pendingIndex = batchIds.get(event.id);
      if (pendingIndex !== void 0) {
        throw new DuplicateEventError(event.id, pendingIndex);
      }
      batchIds.set(event.id, this.lengthValue + batchIds.size);
    }
    for (const event of events) {
      const index = this.lengthValue;
      this.fs.write(this.path(index, event.id), serializeEvent(event));
      this.indexToId.set(index, event.id);
      this.idToIndex.set(event.id, index);
      this.eventCache.set(index, event);
      this.lengthValue += 1;
    }
  }
  scanAndBuildIndex() {
    let paths;
    try {
      paths = this.fs.list(this.dir);
    } catch {
      this.idToIndex.clear();
      this.indexToId.clear();
      this.eventCache.clear();
      return 0;
    }
    const byIndex = /* @__PURE__ */ new Map();
    for (const filePath of paths) {
      const match = eventNamePattern.exec(posixBasename(filePath));
      if (match?.groups === void 0) {
        continue;
      }
      const idx = match.groups.idx;
      const eventId = match.groups.event_id;
      if (idx === void 0 || eventId === void 0) {
        continue;
      }
      byIndex.set(Number(idx), eventId);
    }
    this.idToIndex.clear();
    this.indexToId.clear();
    this.eventCache.clear();
    let length = 0;
    while (byIndex.has(length)) {
      length += 1;
    }
    for (let index = 0; index < length; index += 1) {
      const eventId = byIndex.get(index);
      if (eventId === void 0) {
        break;
      }
      this.indexToId.set(index, eventId);
      if (!this.idToIndex.has(eventId)) {
        this.idToIndex.set(eventId, index);
      }
    }
    return length;
  }
  pathForIndex(index) {
    const eventId = this.indexToId.get(index);
    return eventId === void 0 ? null : this.path(index, eventId);
  }
  path(index, eventId) {
    const filename = EVENT_FILE_PATTERN.replace("{idx}", index.toString().padStart(5, "0")).replace("{event_id}", eventId);
    return joinStorePath(this.dir, filename);
  }
};
function serializeEvent(event) {
  return `${JSON.stringify(event, (_key, value) => {
    if (value instanceof Set) {
      return [...value];
    }
    return value === null ? void 0 : value;
  })}
`;
}
function isEventFileName(name) {
  return name.startsWith("event-") && name.endsWith(".json");
}
function normalizeStoreDir(dirPath) {
  return dirPath.replace(/^\/+|\/+$/gu, "") || ".";
}
function joinStorePath(basePath, childName) {
  if (basePath.length === 0 || basePath === ".") {
    return childName;
  }
  return `${basePath.replace(/\/+$/u, "")}/${childName}`;
}
function contiguousIndexLength(indexToId) {
  let length = 0;
  while (indexToId.has(length)) {
    length += 1;
  }
  return length;
}
function posixBasename(filePath) {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

// src/conversation/state.ts
var conversationExecutionStatus = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  FINISHED: "finished",
  ERROR: "error",
  STUCK: "stuck",
  DELETING: "deleting"
};
var ConversationState = class _ConversationState {
  events;
  eventLog;
  executionStatus;
  constructor(options = {}) {
    this.eventLog = options.eventLog ?? null;
    this.events = this.eventLog === null ? [...options.events ?? []] : this.eventLog.toArray();
    this.executionStatus = options.executionStatus ?? conversationExecutionStatus.IDLE;
    if (this.eventLog !== null) {
      appendMissingEvents(this.eventLog, options.events ?? []);
      this.syncFromDisk();
    }
  }
  appendEvent(event) {
    if (this.eventLog === null) {
      this.events.push(event);
      return event;
    }
    this.eventLog.append(event);
    this.syncFromDisk();
    return event;
  }
  async appendEventAsync(event) {
    await this.appendEventsAsync([event]);
    return event;
  }
  async appendEventsAsync(events) {
    if (events.length === 0) {
      return events;
    }
    if (this.eventLog === null) {
      for (const event of events) {
        this.events.push(event);
      }
      return events;
    }
    await this.eventLog.appendMultipleAsync(events);
    this.syncFromDisk();
    return events;
  }
  syncFromDisk() {
    if (this.eventLog === null) {
      return;
    }
    this.eventLog.refresh();
    this.events.length = 0;
    for (const event of this.eventLog.toArray()) {
      this.events.push(event);
    }
  }
  pendingActions() {
    return _ConversationState.getUnmatchedActions(this.events);
  }
  emitOrphanedActionErrors(error = "Tool call interrupted before completion. The conversation was paused.") {
    const errors = this.pendingActions().map(
      (action) => agentErrorEventSchema.parse({
        error,
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id
      })
    );
    for (const errorEvent of errors) {
      this.appendEvent(errorEvent);
    }
    return errors;
  }
  static getUnmatchedActions(events) {
    const observedActionIds = /* @__PURE__ */ new Set();
    const observedToolCallIds = /* @__PURE__ */ new Set();
    const unmatched = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === void 0) {
        continue;
      }
      if (event.kind === "ObservationEvent" || event.kind === "UserRejectObservation") {
        observedActionIds.add(event.action_id);
        continue;
      }
      if (event.kind === "AgentErrorEvent") {
        observedToolCallIds.add(event.tool_call_id);
        continue;
      }
      if (event.kind === "ActionEvent" && !observedActionIds.has(event.id) && !observedToolCallIds.has(event.tool_call_id)) {
        unmatched.unshift(event);
      }
    }
    return unmatched;
  }
};
function appendMissingEvents(eventLog, events) {
  const missing = events.filter((event) => !eventLog.has(event.id));
  if (missing.length === 0) {
    return;
  }
  try {
    eventLog.appendMultiple(missing);
  } catch (error) {
    if (!(error instanceof DuplicateEventError)) {
      throw error;
    }
    appendMissingEventsIndividually(eventLog, missing);
  }
}
function appendMissingEventsIndividually(eventLog, events) {
  for (const event of events) {
    if (eventLog.has(event.id)) {
      continue;
    }
    try {
      eventLog.append(event);
    } catch (error) {
      if (!(error instanceof DuplicateEventError)) {
        throw error;
      }
    }
  }
}
function actionEventsFromMessage(message, llmResponseId = null) {
  const parsed = messageSchema.parse(message);
  return (parsed.tool_calls ?? []).map(
    (toolCall) => actionEventSchema.parse({
      thought: parsed.content,
      action: parseToolArguments(toolCall.arguments),
      tool_name: toolCall.name,
      tool_call_id: toolCall.id,
      tool_call: toolCall,
      llm_response_id: llmResponseId,
      reasoning_content: parsed.reasoning_content,
      thinking_blocks: parsed.thinking_blocks,
      responses_reasoning_item: parsed.responses_reasoning_item
    })
  );
}
function parseToolArguments(args) {
  try {
    const parsed = JSON.parse(args);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return { arguments: args };
  }
  return { arguments: args };
}
function cancellationToken() {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    get isCancelled() {
      return cancelled;
    }
  };
}
var PendingActionsQueue = class {
  queue;
  constructor(actions = []) {
    this.queue = [...actions];
  }
  get pending() {
    return [...this.queue];
  }
  enqueue(...actions) {
    this.queue.push(...actions);
    return this.queue.length;
  }
  drain(limit = this.queue.length) {
    if (limit <= 0) {
      return [];
    }
    return this.queue.splice(0, limit);
  }
  cancelPending(token) {
    if (!token.isCancelled) {
      return [];
    }
    const skipped = this.drain();
    return skipped.map(
      (action) => agentErrorEventSchema.parse({
        error: "Tool call cancelled by interrupt.",
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id
      })
    );
  }
};
var llmUsageSchema = zod.z.object({
  promptTokens: zod.z.number().int().min(0).default(0),
  completionTokens: zod.z.number().int().min(0).default(0),
  totalTokens: zod.z.number().int().min(0).default(0)
}).strict();
var llmCompletionResponseSchema = zod.z.object({
  message: messageSchema,
  usage: llmUsageSchema.nullable().default(null),
  raw: zod.z.unknown().optional()
}).strict();
var AsyncCallbackWrapper = class {
  callback;
  asyncCallback;
  pending = /* @__PURE__ */ new Set();
  constructor(asyncCallback) {
    this.asyncCallback = asyncCallback;
    this.callback = (event) => this.call(event);
  }
  get pendingCount() {
    return this.pending.size;
  }
  call(event) {
    const pending = Promise.resolve().then(() => this.asyncCallback(event)).catch(() => void 0).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }
  async waitForPending(timeoutMs) {
    const current = [...this.pending];
    if (current.length === 0) {
      return;
    }
    const waitForAll = Promise.allSettled(current).then(() => void 0);
    if (timeoutMs === void 0 || timeoutMs === null) {
      await waitForAll;
      return;
    }
    let timeout;
    try {
      await Promise.race([
        waitForAll,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for async callbacks after ${timeoutMs}ms`)),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timeout !== void 0) {
        clearTimeout(timeout);
      }
    }
  }
};
var DEFAULT_TEXT_CONTENT_LIMIT = 5e4;
var DEFAULT_TRUNCATE_NOTICE = "<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you.</NOTE>";
var DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST = "<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you. The complete output has been saved to {filePath} - you can use other tools to view the full content (truncated part starts around line {lineNum}).</NOTE>";
function maybeTruncate(content, options = {}) {
  const truncateAfter = options.truncateAfter;
  const truncateNotice = options.truncateNotice ?? DEFAULT_TRUNCATE_NOTICE;
  if (truncateAfter === void 0 || truncateAfter === null || truncateAfter <= 0 || content.length <= truncateAfter) {
    return content;
  }
  if (truncateNotice.length >= truncateAfter) {
    return truncateNotice.slice(0, truncateAfter);
  }
  const availableChars = truncateAfter - truncateNotice.length;
  const proposedHead = Math.floor(availableChars / 2) + availableChars % 2;
  let finalNotice = truncateNotice;
  if (options.saveDir !== void 0 && options.saveDir !== null && options.saveDir !== "") {
    const savedFilePath = saveFullContent(content, options.saveDir, options.toolPrefix ?? "output");
    if (savedFilePath !== null) {
      const headContentLines = content.slice(0, proposedHead).split(/\r?\n/u).length;
      finalNotice = DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST.replace("{filePath}", savedFilePath).replace(
        "{lineNum}",
        String(headContentLines + 1)
      );
    }
  }
  if (finalNotice.length >= truncateAfter) {
    return finalNotice.slice(0, truncateAfter);
  }
  const remaining = truncateAfter - finalNotice.length;
  const headChars = Math.min(proposedHead, remaining);
  const tailChars = remaining - headChars;
  return content.slice(0, headChars) + finalNotice + (tailChars > 0 ? content.slice(-tailChars) : "");
}
function saveFullContent(content, saveDir, toolPrefix) {
  try {
    fs.mkdirSync(saveDir, { recursive: true });
    const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 8);
    const filePath = path2__default.default.join(saveDir, `${toolPrefix}_output_${contentHash}.txt`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, "utf8");
    }
    return filePath;
  } catch {
    return null;
  }
}
function toPosixPath(inputPath) {
  return inputPath.toString().replace(/\\/gu, "/");
}
function posixPathName(inputPath) {
  const normalized = toPosixPath(inputPath).replace(/\/+$/u, "");
  if (normalized.length === 0) {
    return "";
  }
  return normalized.split("/").at(-1) ?? "";
}
var urlSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
var windowsDriveAbsolutePattern = /^[A-Za-z]:[\\/]/u;
function isAbsolutePathSource(inputPath) {
  const value = inputPath.toString().trim();
  if (value.length === 0) {
    return false;
  }
  return value.startsWith("/") || value.startsWith("\\") || path2__default.default.isAbsolute(value) || windowsDriveAbsolutePattern.test(value);
}
function isHostAbsolutePath(inputPath) {
  const value = inputPath.toString().trim();
  return value.length > 0 && path2__default.default.isAbsolute(value);
}
function isLocalPathSource(source) {
  const value = source.trim();
  if (value.length === 0) {
    return false;
  }
  if (value.startsWith("file://") || value.startsWith("~") || value.startsWith(".")) {
    return true;
  }
  if (isAbsolutePathSource(value)) {
    return true;
  }
  return value.includes("\\") && !urlSchemePattern.test(value);
}
var ZWJ = "\u200D";
function sanitizeOpenHandsMentions(text) {
  return text.replace(/@(OpenHands)\b/giu, `@${ZWJ}$1`);
}
async function* pageIterator(searchFunc, params) {
  let pageId = typeof params.pageId === "string" ? params.pageId : void 0;
  const rest = { ...params };
  delete rest.pageId;
  while (true) {
    const pageParams = pageId === void 0 ? rest : { ...rest, pageId };
    const page = await searchFunc(pageParams);
    for (const item of page.items) {
      yield item;
    }
    pageId = page.nextPageId ?? void 0;
    if (pageId === void 0 || pageId === "") {
      break;
    }
  }
}
var SENSITIVE_ENV_VARS = /* @__PURE__ */ new Set(["SESSION_API_KEY"]);
function sanitizedEnv(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== void 0) {
      result[key] = value;
    }
  }
  for (const key of SENSITIVE_ENV_VARS) {
    delete result[key];
  }
  if (Object.hasOwn(result, "LD_LIBRARY_PATH_ORIG")) {
    const original = result.LD_LIBRARY_PATH_ORIG;
    if (original === void 0 || original === "") {
      delete result.LD_LIBRARY_PATH;
    } else {
      result.LD_LIBRARY_PATH = original;
    }
  }
  return result;
}
function executeCommand(command, options = {}) {
  const shell = typeof command === "string";
  const executable = shell ? command : command[0];
  if (executable === void 0) {
    throw new Error("Command must not be empty");
  }
  const args = shell ? [] : command.slice(1);
  const result = child_process.spawnSync(executable, args, {
    cwd: options.cwd,
    env: sanitizedEnv(options.env),
    shell,
    timeout: options.timeoutMs,
    encoding: "utf8"
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (options.printOutput ?? true) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  return {
    command,
    status: result.error?.name === "ETIMEDOUT" ? -1 : result.status,
    stdout,
    stderr
  };
}
var SECRET_KEY_PATTERNS = /* @__PURE__ */ new Set([
  "AUTHORIZATION",
  "COOKIE",
  "CREDENTIAL",
  "KEY",
  "PASSWORD",
  "SECRET",
  "SESSION",
  "TOKEN"
]);
var SENSITIVE_URL_PARAMS = /* @__PURE__ */ new Set(["tavilyapikey", "apikey", "api_key", "token", "access_token", "secret", "key"]);
function isSecretKey(key) {
  const upper = key.toUpperCase();
  return [...SECRET_KEY_PATTERNS].some((pattern) => upper.includes(pattern));
}
function redactUrlCredentials(url) {
  return url.replace(/^(https?:\/\/)([^@/]+)@(.+)$/u, "$1****@$3");
}
var embeddedUrlCredentialsPattern = /(https?:\/\/)[^/@\s]+@/gu;
function redactUrlCredentialsInText(text) {
  return text.replace(embeddedUrlCredentialsPattern, "$1****@");
}
function redactUrlParams(url) {
  if (url.length === 0 || !url.includes("?")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.search.length === 0) {
      return url;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMS.has(key.toLowerCase()) || isSecretKey(key)) {
        const values = parsed.searchParams.getAll(key);
        parsed.searchParams.delete(key);
        for (let index = 0; index < Math.max(1, values.length); index += 1) {
          parsed.searchParams.append(key, "<redacted>");
        }
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
var keyValueSecretPattern = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|authorization|cookie|credential|password|secret|session|token|key)[A-Za-z0-9_.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/giu;
var anthropicKeyPattern = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/gu;
function redactTextSecrets(text) {
  return redactUrlCredentialsInText(text).replace(anthropicKeyPattern, "<redacted>").replace(keyValueSecretPattern, (_match, key) => `${key}=<redacted>`);
}
function utcNow() {
  return /* @__PURE__ */ new Date();
}
function dumps(value, space) {
  return JSON.stringify(value, (_key, item) => item, space);
}
function loads(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`No valid JSON object found in response.`, { cause: error });
  }
}
function handleDeprecatedModelFields(data, deprecatedFields) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const result = { ...data };
  for (const field of deprecatedFields) {
    delete result[field];
  }
  return result;
}
function displayJson(value) {
  if (Array.isArray(value)) {
    return [`[List with ${value.length} items]`, ...value.map((item, index) => `  [${index}]: ${formatDisplayValue(item)}`)].join("\n");
  }
  if (value !== null && typeof value === "object") {
    const lines = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === void 0) {
        continue;
      }
      lines.push(`
  ${key}: ${formatDisplayValue(item)}`);
    }
    return lines.join("");
  }
  if (typeof value === "string" && value.includes("\n")) {
    return `String:
${value.split("\n").map((line) => `  ${line}`).join("\n")}`;
  }
  return formatDisplayValue(value);
}
function formatDisplayValue(value) {
  if (typeof value === "string") {
    return value.includes("\n") ? `
${value.split("\n").map((line) => `    ${line}`).join("\n")}` : `"${value}"`;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  return JSON.stringify(value);
}

// src/io/index.ts
var MemoryLRUCache = class {
  maxMemory;
  maxSize;
  currentMemory = 0;
  entries = /* @__PURE__ */ new Map();
  constructor(options) {
    this.maxMemory = options.maxMemory;
    this.maxSize = Math.max(1, options.maxSize);
  }
  get size() {
    return this.entries.size;
  }
  has(key) {
    return this.entries.has(key);
  }
  get(key) {
    const entry = this.entries.get(key);
    if (entry === void 0) {
      return void 0;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    const newSize = valueSize(value);
    if (newSize > this.maxMemory) {
      return this;
    }
    const existing = this.entries.get(key);
    if (existing !== void 0) {
      this.currentMemory -= existing.size;
      this.entries.delete(key);
    }
    this.currentMemory += newSize;
    this.entries.set(key, { value, size: newSize });
    this.evictIfNeeded();
    return this;
  }
  delete(key) {
    const existing = this.entries.get(key);
    if (existing === void 0) {
      return false;
    }
    this.currentMemory -= existing.size;
    return this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
    this.currentMemory = 0;
  }
  keys() {
    return this.entries.keys();
  }
  [Symbol.iterator]() {
    return this.keys();
  }
  evictIfNeeded() {
    while ((this.entries.size > this.maxSize || this.currentMemory > this.maxMemory) && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey === void 0) {
        break;
      }
      this.delete(firstKey);
    }
  }
};
function valueSize(value) {
  if (typeof value === "string") {
    return value.length;
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  return JSON.stringify(value)?.length ?? 0;
}
var LocalFileStore = class {
  root;
  cache;
  locks = /* @__PURE__ */ new Set();
  constructor(root, options = {}) {
    const expandedRoot = root.startsWith("~") ? path2__default.default.join(process.env.HOME ?? "", root.slice(1)) : root;
    this.root = path2__default.default.resolve(path2__default.default.normalize(expandedRoot));
    fs.mkdirSync(this.root, { recursive: true });
    this.cache = new MemoryLRUCache({
      maxMemory: options.cacheMemorySize ?? 20 * 1024 * 1024,
      maxSize: options.cacheLimitSize ?? 500
    });
  }
  getFullPath(filePath) {
    const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const fullPath = path2__default.default.resolve(path2__default.default.normalize(path2__default.default.join(this.root, toPosixPath(relativePath))));
    const relativeToRoot = path2__default.default.relative(this.root, fullPath);
    if (relativeToRoot.startsWith("..") || path2__default.default.isAbsolute(relativeToRoot)) {
      throw new ValueError(`path escapes filestore root: ${filePath}`);
    }
    return fullPath;
  }
  getAbsolutePath(filePath) {
    return this.getFullPath(filePath);
  }
  write(filePath, contents) {
    const fullPath = this.getFullPath(filePath);
    fs.mkdirSync(path2__default.default.dirname(fullPath), { recursive: true });
    if (typeof contents === "string") {
      fs.writeFileSync(fullPath, contents, "utf8");
      this.cache.set(fullPath, contents);
    } else {
      fs.writeFileSync(fullPath, contents);
      this.cache.delete(fullPath);
    }
  }
  read(filePath) {
    const fullPath = this.getFullPath(filePath);
    const cached = this.cache.get(fullPath);
    if (cached !== void 0) {
      return cached;
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const contents = fs.readFileSync(fullPath, "utf8");
    this.cache.set(fullPath, contents);
    return contents;
  }
  list(filePath) {
    const fullPath = this.getFullPath(filePath);
    if (!fs.existsSync(fullPath)) {
      return [];
    }
    if (fs.statSync(fullPath).isFile()) {
      return [filePath];
    }
    return readdirNames(fullPath).map((name) => {
      const child = joinStorePath2(filePath, name);
      return fs.statSync(this.getFullPath(child)).isDirectory() ? `${child}/` : child;
    });
  }
  lock(filePath, callback, options = {}) {
    assertSynchronousLockCallback(callback);
    const fullPath = this.getFullPath(filePath);
    if (this.locks.has(fullPath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }
    fs.mkdirSync(path2__default.default.dirname(fullPath), { recursive: true });
    const deadline = Date.now() + (options.timeoutSeconds ?? 30) * 1e3;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    let acquired = false;
    while (!acquired) {
      try {
        const fd = fs.openSync(fullPath, "wx");
        try {
          try {
            fs.writeFileSync(fd, `${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
            acquired = true;
          } finally {
            closeLockDescriptor(fd);
          }
        } catch (error) {
          removeLockFile(fullPath);
          throw error;
        }
      } catch (error) {
        if (!isExistingLockError(error) || Date.now() >= deadline) {
          throw error;
        }
        removeStaleLockFile(fullPath);
        sleepSync(pollIntervalMs);
      }
    }
    this.locks.add(fullPath);
    try {
      const result = callback();
      assertSynchronousLockResult(result);
      return result;
    } finally {
      try {
        removeLockFile(fullPath);
      } finally {
        this.cache.delete(fullPath);
        this.locks.delete(fullPath);
      }
    }
  }
  async lockAsync(filePath, callback, options = {}) {
    const fullPath = this.getFullPath(filePath);
    if (this.locks.has(fullPath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }
    await promises.mkdir(path2__default.default.dirname(fullPath), { recursive: true });
    const deadline = Date.now() + (options.timeoutSeconds ?? 30) * 1e3;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    let acquired = false;
    while (!acquired) {
      try {
        const handle = await promises.open(fullPath, "wx");
        try {
          try {
            await handle.writeFile(`${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
            acquired = true;
          } finally {
            await closeLockDescriptorAsync(handle);
          }
        } catch (error) {
          await removeLockFileAsync(fullPath);
          throw error;
        }
      } catch (error) {
        if (!isExistingLockError(error) || Date.now() >= deadline) {
          throw error;
        }
        await removeStaleLockFileAsync(fullPath);
        await sleepAsync(pollIntervalMs);
      }
    }
    this.locks.add(fullPath);
    let result;
    let callbackFailed = false;
    let cleanupError;
    try {
      result = await callback();
    } catch (error) {
      callbackFailed = true;
      throw error;
    } finally {
      try {
        await removeLockFileAsync(fullPath);
      } catch (error) {
        if (!callbackFailed) {
          cleanupError = error;
        }
      } finally {
        this.cache.delete(fullPath);
        this.locks.delete(fullPath);
      }
    }
    if (cleanupError !== void 0) {
      throw cleanupError instanceof Error ? cleanupError : new Error("FileStore lock cleanup failed", { cause: cleanupError });
    }
    return result;
  }
  delete(filePath) {
    const fullPath = this.getFullPath(filePath);
    if (!fs.existsSync(fullPath)) {
      return;
    }
    const stats = fs.statSync(fullPath);
    fs.rmSync(fullPath, { recursive: stats.isDirectory(), force: true });
    if (stats.isDirectory()) {
      this.cache.clear();
    } else {
      this.cache.delete(fullPath);
    }
  }
  exists(filePath) {
    return fs.existsSync(this.getFullPath(filePath));
  }
};
var InMemoryFileStore = class {
  files;
  instanceId = crypto.randomUUID().replace(/-/gu, "");
  locks = /* @__PURE__ */ new Set();
  constructor(files = {}, options = {}) {
    this.files = new MemoryLRUCache({
      maxMemory: options.cacheMemorySize ?? 20 * 1024 * 1024,
      maxSize: options.cacheLimitSize ?? 1e5
    });
    for (const [filePath, contents] of Object.entries(files)) {
      this.files.set(filePath, contents);
    }
  }
  write(filePath, contents) {
    this.files.set(filePath, typeof contents === "string" ? contents : contents.toString("utf8"));
  }
  read(filePath) {
    const contents = this.files.get(filePath);
    if (contents === void 0) {
      throw new Error(`File not found: ${filePath}`);
    }
    return contents;
  }
  list(filePath) {
    const files = [];
    const normalizedPrefix = filePath.replace(/\/+$/u, "");
    for (const storedPath of this.files.keys()) {
      if (!storedPath.startsWith(normalizedPrefix)) {
        continue;
      }
      const suffix = storedPath.slice(normalizedPrefix.length).replace(/^\//u, "");
      const [firstPart, ...rest] = suffix.split("/");
      if (firstPart === void 0 || firstPart.length === 0) {
        continue;
      }
      const listedPath = rest.length === 0 ? storedPath : `${joinStorePath2(normalizedPrefix, firstPart)}/`;
      if (!files.includes(listedPath)) {
        files.push(listedPath);
      }
    }
    return files;
  }
  delete(filePath) {
    for (const storedPath of [...this.files.keys()]) {
      if (storedPath === filePath || storedPath.startsWith(`${filePath}/`)) {
        this.files.delete(storedPath);
      }
    }
  }
  exists(filePath) {
    if (this.files.has(filePath)) {
      return true;
    }
    return [...this.files.keys()].some((storedPath) => storedPath.startsWith(`${filePath}/`));
  }
  lock(filePath, callback, _options = {}) {
    assertSynchronousLockCallback(callback);
    if (this.locks.has(filePath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }
    this.locks.add(filePath);
    try {
      const result = callback();
      assertSynchronousLockResult(result);
      return result;
    } finally {
      this.locks.delete(filePath);
    }
  }
  async lockAsync(filePath, callback, _options = {}) {
    if (this.locks.has(filePath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }
    this.locks.add(filePath);
    try {
      return await callback();
    } finally {
      this.locks.delete(filePath);
    }
  }
  getAbsolutePath(filePath) {
    return path2__default.default.join(os.tmpdir(), `openhands_inmemory_${this.instanceId}`, filePath);
  }
};
var ValueError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
};
function joinStorePath2(basePath, childName) {
  if (basePath.length === 0 || basePath === ".") {
    return childName;
  }
  return `${basePath.replace(/\/+$/u, "")}/${childName}`;
}
var asyncFunctionConstructor = (async () => {
  await Promise.resolve();
}).constructor;
var MALFORMED_LOCK_STALE_GRACE_MS = 5e3;
function assertSynchronousLockCallback(callback) {
  if (callback.constructor === asyncFunctionConstructor) {
    throw new Error("FileStore.lock does not support asynchronous callbacks because it is synchronous.");
  }
}
function assertSynchronousLockResult(result) {
  if (isPromiseLike(result)) {
    throw new Error("FileStore.lock does not support asynchronous callbacks because it is synchronous.");
  }
}
function isPromiseLike(value) {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
function closeLockDescriptor(fd) {
  try {
    fs.closeSync(fd);
  } catch {
  }
}
function readdirNames(directory) {
  return fs.statSync(directory).isDirectory() ? fs.readdirSync(directory).sort() : [];
}
function isExistingLockError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function closeLockDescriptorAsync(handle) {
  try {
    await handle.close();
  } catch {
  }
}
function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}
function sleepAsync(milliseconds) {
  return new Promise((resolve5) => {
    setTimeout(resolve5, milliseconds);
  });
}
function removeStaleLockFile(lockPath) {
  let contents;
  try {
    contents = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const pidLine = (contents.split(/\r?\n/u)[0] ?? "").trim();
  if (!/^\d+$/u.test(pidLine)) {
    if (isMalformedLockWithinGracePeriod(lockPath)) {
      return;
    }
    removeLockFile(lockPath);
    return;
  }
  const pid = Number.parseInt(pidLine, 10);
  if (pid > 0 && isProcessAlive(pid)) {
    return;
  }
  removeLockFile(lockPath);
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}
function isMalformedLockWithinGracePeriod(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < MALFORMED_LOCK_STALE_GRACE_MS;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}
function removeLockFile(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}
async function removeStaleLockFileAsync(lockPath) {
  let contents;
  try {
    contents = await promises.readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isTransientLockAccessError(error)) {
      return;
    }
    throw error;
  }
  const pidLine = (contents.split(/\r?\n/u)[0] ?? "").trim();
  if (!/^\d+$/u.test(pidLine)) {
    if (await isMalformedLockWithinGracePeriodAsync(lockPath)) {
      return;
    }
    await removeLockFileAsync(lockPath);
    return;
  }
  const pid = Number.parseInt(pidLine, 10);
  if (pid > 0 && isProcessAlive(pid)) {
    return;
  }
  await removeLockFileAsync(lockPath);
}
async function isMalformedLockWithinGracePeriodAsync(lockPath) {
  try {
    return Date.now() - (await promises.stat(lockPath)).mtimeMs < MALFORMED_LOCK_STALE_GRACE_MS;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isTransientLockAccessError(error)) {
      return true;
    }
    throw error;
  }
}
async function removeLockFileAsync(lockPath) {
  try {
    await promises.unlink(lockPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}
function isNodeErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isTransientLockAccessError(error) {
  return isNodeErrorCode(error, "EACCES") || isNodeErrorCode(error, "EPERM") || isNodeErrorCode(error, "EBUSY");
}

// src/conversation/stuck-detector.ts
var DEFAULT_THRESHOLD = 4;
var StuckDetector = class {
  state;
  thresholds;
  constructor(state, thresholds = {}) {
    this.state = state;
    this.thresholds = {
      actionObservation: thresholds.actionObservation ?? DEFAULT_THRESHOLD,
      actionError: thresholds.actionError ?? DEFAULT_THRESHOLD,
      monologue: thresholds.monologue ?? DEFAULT_THRESHOLD,
      alternatingPattern: thresholds.alternatingPattern ?? DEFAULT_THRESHOLD * 2
    };
  }
  isStuck() {
    const events = eventsSinceLastUser(this.state.events.slice(-20));
    if (events.length < Math.min(this.thresholds.actionObservation, this.thresholds.actionError, this.thresholds.monologue)) {
      return false;
    }
    return this.hasRepeatingActionObservation(events) || this.hasRepeatingActionError(events) || this.hasMonologue(events);
  }
  hasRepeatingActionObservation(events) {
    const pairs = actionObservationPairs(events).slice(-this.thresholds.actionObservation);
    if (pairs.length < this.thresholds.actionObservation) {
      return false;
    }
    const [first] = pairs;
    return first !== void 0 && pairs.every((pair) => sameAction(first.action, pair.action) && sameObservation(first.observation, pair.observation));
  }
  hasRepeatingActionError(events) {
    const pairs = actionObservationPairs(events).slice(-this.thresholds.actionError);
    if (pairs.length < this.thresholds.actionError) {
      return false;
    }
    const [first] = pairs;
    return first !== void 0 && pairs.every((pair) => sameAction(first.action, pair.action) && pair.observation.kind === "AgentErrorEvent");
  }
  hasMonologue(events) {
    let count = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind !== "MessageEvent") {
        continue;
      }
      if (event.source === "agent") {
        count += 1;
        if (count >= this.thresholds.monologue) {
          return true;
        }
      } else if (event.source === "user") {
        return false;
      }
    }
    return false;
  }
};
function eventsSinceLastUser(events) {
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "MessageEvent" && event.source === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex === -1 ? [...events] : events.slice(lastUserIndex + 1);
}
function actionObservationPairs(events) {
  const pairs = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const action = events[index];
    const observation = events[index + 1];
    if (action?.kind === "ActionEvent" && isObservationLike(observation)) {
      pairs.push({ action, observation });
    }
  }
  return pairs;
}
function isObservationLike(event) {
  return event?.kind === "ObservationEvent" || event?.kind === "UserRejectObservation" || event?.kind === "AgentErrorEvent";
}
function sameAction(left, right) {
  return left.tool_name === right.tool_name && stableStringify(left.action) === stableStringify(right.action);
}
function sameObservation(left, right) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "ObservationEvent" && right.kind === "ObservationEvent") {
    return left.tool_name === right.tool_name && stableStringify(left.observation) === stableStringify(right.observation);
  }
  if (left.kind === "UserRejectObservation" && right.kind === "UserRejectObservation") {
    return left.tool_name === right.tool_name && left.rejection_reason === right.rejection_reason;
  }
  if (left.kind === "AgentErrorEvent" && right.kind === "AgentErrorEvent") {
    return left.tool_name === right.tool_name && left.error === right.error;
  }
  return false;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

// src/conversation/local-conversation.ts
var LocalConversation = class {
  agent;
  state;
  maxIterations;
  stuckDetector;
  conversationId;
  constructor(options) {
    this.agent = options.agent;
    this.conversationId = options.conversationId ?? (options.state === void 0 && hasPersistentStore(options) ? crypto.randomUUID() : null);
    this.state = options.state ?? createConversationState(options, this.conversationId);
    this.maxIterations = options.maxIterations ?? 500;
    this.stuckDetector = createStuckDetector(this.state, options.stuckDetection);
  }
  sendMessage(text) {
    const event = this.createUserMessageEvent(text);
    this.state.appendEvent(event);
    this.resetIdleStatusAfterMessage();
    return event;
  }
  async sendMessageAsync(text) {
    const event = this.createUserMessageEvent(text);
    await this.state.appendEventAsync(event);
    this.resetIdleStatusAfterMessage();
    return event;
  }
  pause() {
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }
  resume() {
    if (this.state.executionStatus === conversationExecutionStatus.PAUSED) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
  }
  async run() {
    if (this.state.executionStatus === conversationExecutionStatus.PAUSED) {
      return;
    }
    if (this.state.executionStatus === conversationExecutionStatus.IDLE || this.state.executionStatus === conversationExecutionStatus.ERROR || this.state.executionStatus === conversationExecutionStatus.STUCK) {
      this.state.executionStatus = conversationExecutionStatus.RUNNING;
    }
    let iteration = 0;
    while (this.state.executionStatus === conversationExecutionStatus.RUNNING) {
      if (this.stuckDetector?.isStuck() === true) {
        this.state.executionStatus = conversationExecutionStatus.STUCK;
        return;
      }
      const emitted = await this.agent.step(this.state);
      iteration += 1;
      if (emitted.some(isSuccessfulFinishObservation)) {
        this.state.executionStatus = conversationExecutionStatus.FINISHED;
        return;
      }
      if (iteration >= this.maxIterations) {
        this.state.executionStatus = conversationExecutionStatus.ERROR;
        await this.state.appendEventAsync(
          conversationErrorEventSchema.parse({
            source: "environment",
            code: "MaxIterationsReached",
            detail: `Agent reached maximum iterations limit (${this.maxIterations}).`
          })
        );
        return;
      }
    }
  }
  async arun() {
    await this.run();
  }
  createUserMessageEvent(text) {
    return messageEventSchema.parse({
      source: "user",
      llm_message: {
        role: "user",
        content: [textContent(text)]
      }
    });
  }
  resetIdleStatusAfterMessage() {
    if (this.state.executionStatus !== conversationExecutionStatus.RUNNING) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
  }
};
function hasPersistentStore(options) {
  return options.fileStore !== void 0 || options.conversationsDir !== void 0 || options.conversationId !== void 0;
}
function createConversationState(options, conversationId) {
  if (conversationId === null) {
    return new ConversationState();
  }
  const store = options.fileStore ?? new LocalFileStore(options.conversationsDir ?? ".openhands/conversations");
  return new ConversationState({ eventLog: new EventLog(store, conversationEventDir(conversationId)) });
}
function conversationEventDir(conversationId) {
  const safeConversationId = conversationId.replace(/^\/+|\/+$/gu, "");
  if (safeConversationId.length === 0 || safeConversationId.includes("..")) {
    throw new Error(`Invalid conversationId: ${conversationId}`);
  }
  return `${safeConversationId}/${EVENTS_DIR}`;
}
function createStuckDetector(state, option) {
  if (option === void 0 || option === false) {
    return null;
  }
  if (option === true) {
    return new StuckDetector(state);
  }
  return new StuckDetector(state, option);
}
function isSuccessfulFinishObservation(event) {
  if (event.kind !== "ObservationEvent" || event.tool_name !== "finish") {
    return false;
  }
  const isError = event.observation.is_error;
  return isError !== true;
}

// src/conversation/parallel-executor.ts
var ParallelToolExecutor = class {
  maxConcurrency;
  constructor(options = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
  }
  async executeBatch(actions, runner, options = {}) {
    if (actions.length === 0) {
      return [];
    }
    const results = Array.from({ length: actions.length }, () => []);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < actions.length) {
        const index = nextIndex;
        nextIndex += 1;
        const action = actions[index];
        if (action !== void 0) {
          results[index] = await this.runSafe(action, runner, options.cancelToken ?? null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, actions.length) }, () => worker()));
    return results;
  }
  async runSafe(action, runner, cancelToken) {
    if (cancelToken?.isCancelled === true) {
      return [cancelledError(action)];
    }
    try {
      return [...await runner(action)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        agentErrorEventSchema.parse({
          error: `Error executing tool '${action.tool_name}': ${message}`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id
        })
      ];
    }
  }
};
function cancelledError(action) {
  return agentErrorEventSchema.parse({
    error: "Tool call cancelled by interrupt.",
    tool_name: action.tool_name,
    tool_call_id: action.tool_call_id
  });
}

// src/conversation/remote-conversation.ts
var RemoteConversation = class {
  host;
  id;
  state;
  fetcher;
  apiKey;
  constructor(options) {
    this.host = options.host.replace(/\/+$/, "");
    this.id = options.conversationId;
    this.state = options.state ?? new ConversationState();
    this.fetcher = options.fetch ?? globalRemoteFetch();
    this.apiKey = options.apiKey ?? null;
  }
  async sendMessage(message, sender) {
    const parsed = typeof message === "string" ? userMessage(message) : messageSchema.parse(message);
    if (parsed.role !== "user") {
      throw new Error("Only user messages can be sent to a remote conversation");
    }
    await this.request("POST", `${this.actionBasePath}/events`, {
      role: parsed.role,
      content: parsed.content,
      run: false,
      ...sender === void 0 ? {} : { sender }
    });
  }
  async run(options = {}) {
    const blocking = options.blocking ?? true;
    await this.request("POST", `${this.actionBasePath}/run`, void 0, /* @__PURE__ */ new Set([200, 201, 204, 409]));
    if (!blocking) {
      this.state.executionStatus = conversationExecutionStatus.RUNNING;
      return;
    }
    await this.waitForRunCompletion(options.pollIntervalMs ?? 1e3, options.timeoutMs ?? 36e5);
  }
  async pause() {
    await this.request("POST", `${this.actionBasePath}/pause`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }
  async interrupt() {
    await this.request("POST", `${this.actionBasePath}/interrupt`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }
  async waitForRunCompletion(pollIntervalMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.pollStatus();
      if (status !== null) {
        this.state.executionStatus = status;
      }
      if (status === conversationExecutionStatus.ERROR) {
        throw new Error(`Remote conversation ${this.id} ended with error`);
      }
      if (status === conversationExecutionStatus.STUCK) {
        throw new Error(`Remote conversation ${this.id} got stuck`);
      }
      if (status !== null && status !== conversationExecutionStatus.RUNNING && status !== conversationExecutionStatus.IDLE) {
        return;
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Remote conversation ${this.id} run timed out after ${timeoutMs}ms`);
  }
  async pollStatus() {
    const info = await this.request("GET", this.infoPath);
    if (isRecord2(info) && typeof info.execution_status === "string" && isExecutionStatus(info.execution_status)) {
      return info.execution_status;
    }
    return null;
  }
  async request(method, url, payload, acceptableStatusCodes) {
    const headers = {};
    if (payload !== void 0) {
      headers["content-type"] = "application/json";
    }
    if (this.apiKey !== null) {
      headers["x-session-api-key"] = this.apiKey;
    }
    const response = await this.fetcher.request(url, payload === void 0 ? { method, headers } : { method, headers, body: JSON.stringify(payload) });
    if (!(acceptableStatusCodes?.has(response.status) ?? response.ok)) {
      throw new Error(`Remote conversation request failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }
  get actionBasePath() {
    return `${this.host}/api/conversations/${encodeURIComponent(this.id)}`;
  }
  get infoPath() {
    return `${this.host}/api/conversations/${encodeURIComponent(this.id)}`;
  }
};
function userMessage(text) {
  return messageSchema.parse({ role: "user", content: [textContent(text)] });
}
function isExecutionStatus(status) {
  return Object.values(conversationExecutionStatus).includes(status);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sleep(ms) {
  return new Promise((resolve5) => setTimeout(resolve5, ms));
}
function globalRemoteFetch() {
  return {
    async request(url, init) {
      const response = await fetch(url, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
        text: async () => response.text()
      };
    }
  };
}

// src/conversation/restore.ts
var unsupportedStateFields = /* @__PURE__ */ new Set([
  "confirmation_policy",
  "security_analyzer",
  "secret_registry"
]);
var unsupportedEventFields = /* @__PURE__ */ new Set([
  "critic_result",
  "security_risk",
  "summary"
]);
function restoreConversationState(payload) {
  const source = Array.isArray(payload) ? { events: payload } : recordOrThrow(payload, "conversation restore payload");
  const droppedStateFields = sortedKeys(source, unsupportedStateFields);
  const droppedEventFields = [];
  const eventPayloads = Array.isArray(source.events) ? source.events : [];
  const events = eventPayloads.map((event, index) => migrateEvent(event, index, droppedEventFields));
  const executionStatus = parseExecutionStatus(source.executionStatus ?? source.execution_status);
  return {
    state: new ConversationState({ events, executionStatus }),
    droppedStateFields,
    droppedEventFields
  };
}
function migrateEvent(payload, index, droppedEventFields) {
  const event = { ...recordOrThrow(payload, `event ${index}`) };
  const dropped = sortedKeys(event, unsupportedEventFields);
  for (const field of dropped) {
    delete event[field];
  }
  if (isRecord3(event.tool_call)) {
    const toolCall = { ...event.tool_call };
    if (Object.hasOwn(toolCall, "security_risk")) {
      delete toolCall.security_risk;
      dropped.push("tool_call.security_risk");
    }
    event.tool_call = toolCall;
  }
  if (event.kind === "ActionEvent" && !isRecord3(event.action)) {
    event.action = actionFromToolCall(event.tool_call);
  }
  if (dropped.length > 0) {
    droppedEventFields.push({ index, fields: dropped });
  }
  return eventSchema.parse(event);
}
function parseExecutionStatus(value) {
  if (typeof value === "string" && Object.values(conversationExecutionStatus).includes(value)) {
    return value;
  }
  return conversationExecutionStatus.IDLE;
}
function actionFromToolCall(toolCall) {
  if (!isRecord3(toolCall) || typeof toolCall.arguments !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments);
    if (isRecord3(parsed)) {
      return parsed;
    }
  } catch {
    return { arguments: toolCall.arguments };
  }
  return { arguments: toolCall.arguments };
}
function sortedKeys(record, fields) {
  return Object.keys(record).filter((key) => fields.has(key)).sort();
}
function recordOrThrow(value, name) {
  if (isRecord3(value)) {
    return value;
  }
  throw new TypeError(`${name} must be an object`);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/agent/response-dispatch.ts
var llmResponseType = {
  TOOL_CALLS: "tool_calls",
  CONTENT: "content",
  REASONING_ONLY: "reasoning_only",
  EMPTY: "empty"
};
function classifyResponse(message) {
  const parsed = messageSchema.parse(message);
  if (parsed.tool_calls !== null && parsed.tool_calls.length > 0) {
    return llmResponseType.TOOL_CALLS;
  }
  if (parsed.content.some((content) => content.type === "text" && content.text.trim().length > 0)) {
    return llmResponseType.CONTENT;
  }
  if (parsed.responses_reasoning_item !== null || parsed.reasoning_content !== null || parsed.thinking_blocks.length > 0) {
    return llmResponseType.REASONING_ONLY;
  }
  return llmResponseType.EMPTY;
}
async function dispatchLlmResponse(response, state, runner, options = {}) {
  const emitted = [];
  const message = messageSchema.parse(response.message);
  if (classifyResponse(message) === llmResponseType.TOOL_CALLS) {
    const actions = actionEventsFromMessage(message, options.llmResponseId ?? null);
    for (const event of await state.appendEventsAsync(actions)) {
      emitted.push(event);
    }
    const executor = options.executor ?? new ParallelToolExecutor(options.maxConcurrency === void 0 ? {} : { maxConcurrency: options.maxConcurrency });
    const results = await executor.executeBatch(actions, runner);
    for (const batch of results) {
      for (const event of await state.appendEventsAsync(batch)) {
        emitted.push(event);
      }
    }
    return emitted;
  }
  if (classifyResponse(message) === llmResponseType.CONTENT || classifyResponse(message) === llmResponseType.REASONING_ONLY) {
    emitted.push(
      await state.appendEventAsync(
        messageEventSchema.parse({
          source: "agent",
          llm_message: message,
          llm_response_id: options.llmResponseId ?? null
        })
      )
    );
  }
  return emitted;
}

// src/agent/agent.ts
var Agent = class {
  llm;
  tools;
  toolConcurrencyLimit;
  context;
  condenser;
  systemPrompt;
  constructor(options) {
    this.llm = options.llm;
    this.tools = [...options.tools ?? []];
    this.toolConcurrencyLimit = Math.max(1, options.toolConcurrencyLimit ?? 1);
    this.context = options.context ?? null;
    this.condenser = options.condenser ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
  }
  async step(state) {
    const messages = this.messagesForState(state);
    if (messages === null) {
      return [state.events.at(-1)].filter((event) => event !== void 0);
    }
    const response = await this.llm.complete(messages, this.tools.filter((tool) => tool.usable));
    return dispatchLlmResponse(response, state, (action) => this.runTool(action), {
      maxConcurrency: this.toolConcurrencyLimit
    });
  }
  messagesForState(state) {
    const view = View.fromEvents(state.events);
    const condensed = this.condenser?.condense(view, this.llm) ?? view;
    if (!(condensed instanceof View)) {
      state.appendEvent(condensed);
      return null;
    }
    const messages = eventsToMessages(condensed.events.filter(isLlmConvertibleEvent));
    const system = this.renderSystemPrompt();
    if (system !== null) {
      return [systemMessage(system), ...messages];
    }
    return messages;
  }
  renderSystemPrompt() {
    const suffix = this.context?.getSystemMessageSuffix() ?? null;
    if (this.systemPrompt !== null && suffix !== null) {
      return `${this.systemPrompt}

${suffix}`;
    }
    return this.systemPrompt ?? suffix;
  }
  async runTool(action) {
    const tool = this.tools.find((candidate) => candidate.name === action.tool_name);
    if (tool === void 0) {
      return [
        agentErrorEventSchema.parse({
          error: `Unknown tool '${action.tool_name}'`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id
        })
      ];
    }
    const observation = await tool.execute(action.action);
    return [
      observationEventSchema.parse({
        action_id: action.id,
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
        observation
      })
    ];
  }
};
function isLlmConvertibleEvent(event) {
  return event.kind === "SystemPromptEvent" || event.kind === "MessageEvent" || event.kind === "ActionEvent" || event.kind === "ObservationEvent" || event.kind === "UserRejectObservation" || event.kind === "AgentErrorEvent" || event.kind === "CondensationSummaryEvent";
}
function systemMessage(text) {
  return {
    role: "system",
    content: [textContent(text)],
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null
  };
}

// src/critic/index.ts
var CriticResult = class _CriticResult {
  static THRESHOLD = 0.5;
  static DISPLAY_THRESHOLD = 0.2;
  score;
  message;
  metadata;
  constructor(options) {
    if (options.score < 0 || options.score > 1) {
      throw new Error("Critic score must be between 0 and 1");
    }
    this.score = options.score;
    this.message = options.message ?? null;
    this.metadata = options.metadata ?? null;
  }
  get success() {
    return this.score >= _CriticResult.THRESHOLD;
  }
  get starRating() {
    const filled = Math.round(this.score * 5);
    return "\u2605".repeat(filled) + "\u2606".repeat(5 - filled);
  }
  visualize() {
    const percentage = (this.score * 100).toFixed(1);
    return `Critic: agent success likelihood ${this.starRating} (${percentage}%)${this.message ? `
  ${this.message}` : ""}`;
  }
};
var CriticBase = class {
  mode;
  iterative_refinement;
  constructor(options = {}) {
    this.mode = options.mode ?? "finish_and_message";
    this.iterative_refinement = options.iterative_refinement === void 0 || options.iterative_refinement === null ? null : {
      success_threshold: options.iterative_refinement.success_threshold ?? 0.6,
      max_iterations: options.iterative_refinement.max_iterations ?? 3
    };
  }
  getFollowupPrompt(criticResult, iteration) {
    const scorePercent = (criticResult.score * 100).toFixed(1);
    return `The task appears incomplete (iteration ${iteration}, predicted success likelihood: ${scorePercent}%).

Please review what you've done and verify each requirement is met.
List what's working and what needs fixing, then complete the task.
`;
  }
  shouldRefine(criticResult) {
    return this.iterative_refinement !== null && criticResult.score < this.iterative_refinement.success_threshold;
  }
};
var PassCritic = class extends CriticBase {
  evaluate() {
    return new CriticResult({ score: 1, message: "PassCritic always succeeds" });
  }
};
var EmptyPatchCritic = class extends CriticBase {
  evaluate(_events, gitPatch) {
    if (gitPatch === void 0 || gitPatch === null || gitPatch.trim().length === 0) {
      return new CriticResult({ score: 0, message: "Git patch is empty or missing" });
    }
    return new CriticResult({ score: 1, message: "Git patch is non-empty" });
  }
};
var AgentFinishedCritic = class extends CriticBase {
  evaluate(events, gitPatch) {
    if (gitPatch === void 0 || gitPatch === null || gitPatch.trim().length === 0) {
      return new CriticResult({ score: 0, message: "Agent did not produce a non-empty git patch. Empty git patch" });
    }
    if (!hasFinishAction(events)) {
      return new CriticResult({ score: 0, message: "Agent did not finish properly. No FinishAction found" });
    }
    return new CriticResult({ score: 1, message: "Agent completed with FinishAction and non-empty patch" });
  }
};
function hasFinishAction(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "ActionEvent") {
      return event.tool_name === "FinishTool" || event.tool_name === "finish";
    }
  }
  return false;
}
var execFileAsync2 = util.promisify(child_process.execFile);
var GIT_EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var MAX_FILE_SIZE_FOR_GIT_DIFF = 1024 * 1024;
var GitChangeStatus = /* @__PURE__ */ ((GitChangeStatus2) => {
  GitChangeStatus2["MOVED"] = "MOVED";
  GitChangeStatus2["ADDED"] = "ADDED";
  GitChangeStatus2["DELETED"] = "DELETED";
  GitChangeStatus2["UPDATED"] = "UPDATED";
  return GitChangeStatus2;
})(GitChangeStatus || {});
var GitError = class extends Error {
};
var GitRepositoryError = class extends GitError {
  constructor(message, command = null, exitCode = null) {
    super(message);
    this.command = command;
    this.exitCode = exitCode;
  }
  command;
  exitCode;
};
var GitCommandError = class extends GitError {
  constructor(message, command, exitCode, stderr = "") {
    super(message);
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
  command;
  exitCode;
  stderr;
};
var GitPathError = class extends GitError {
};
async function runGitCommand(args, options = {}) {
  const redactedArgs = args.map(redactUrlCredentials2);
  try {
    const { stdout } = await execFileAsync2(args[0] ?? "git", args.slice(1), { cwd: options.cwd ?? void 0, timeout: (options.timeoutSeconds ?? 30) * 1e3 });
    return stdout.trim();
  } catch (error) {
    if (isExecError2(error)) {
      throw new GitCommandError(`Git command failed: ${redactedArgs.join(" ")}`, redactedArgs, typeof error.code === "number" ? error.code : -1, redactUrlCredentialsInText2(error.stderr ?? "").trim());
    }
    throw error;
  }
}
async function validateGitRepository(repoDir) {
  const repoPath = path2.resolve(repoDir);
  const info = await promises.stat(repoPath).catch(() => null);
  if (info === null) {
    throw new GitRepositoryError(`Directory does not exist: ${repoPath}`);
  }
  if (!info.isDirectory()) {
    throw new GitRepositoryError(`Path is not a directory: ${repoPath}`);
  }
  try {
    await runGitCommand(["git", "rev-parse", "--git-dir"], { cwd: repoPath });
  } catch (error) {
    throw new GitRepositoryError(`Not a git repository: ${repoPath}`, "git rev-parse --git-dir", error instanceof GitCommandError ? error.exitCode : null);
  }
  return repoPath;
}
async function getValidRef(repoDir, override) {
  if (override !== void 0 && override !== null) {
    try {
      return await runGitCommand(["git", "--no-pager", "rev-parse", "--verify", `${override}^{commit}`], { cwd: repoDir });
    } catch (error) {
      if (override === "HEAD") {
        return GIT_EMPTY_TREE_HASH;
      }
      throw error;
    }
  }
  if (!await repoHasCommits(repoDir)) {
    return GIT_EMPTY_TREE_HASH;
  }
  return GIT_EMPTY_TREE_HASH;
}
async function getChangesInRepo(repoDir, ref) {
  const repo = await validateGitRepository(repoDir);
  const base = await getValidRef(repo, ref);
  const output = await runGitCommand(["git", "--no-pager", "diff", "--name-status", base], { cwd: repo });
  const changes = [];
  for (const line of output.split(/\r?\n/u).filter((entry) => entry.trim().length > 0)) {
    const parts = line.split(/\s+/u);
    const status = parts[0] ?? "";
    if (status.startsWith("R") && parts.length === 3) {
      changes.push({ status: "DELETED" /* DELETED */, path: toPosixPath2(parts[1] ?? "") }, { status: "ADDED" /* ADDED */, path: toPosixPath2(parts[2] ?? "") });
    } else if (status.startsWith("C") && parts.length === 3) {
      changes.push({ status: "ADDED" /* ADDED */, path: toPosixPath2(parts[2] ?? "") });
    } else if (parts.length === 2) {
      changes.push({ status: mapGitStatus(status), path: toPosixPath2(parts[1] ?? "") });
    } else {
      throw new GitCommandError(`Unexpected git diff output format: ${line}`, ["git", "diff", "--name-status"], 0, "Invalid output format");
    }
  }
  const untracked = await runGitCommand(["git", "--no-pager", "ls-files", "--others", "--exclude-standard"], { cwd: repo }).catch(() => "");
  for (const path3 of untracked.split(/\r?\n/u).filter((entry) => entry.trim().length > 0)) {
    changes.push({ status: "ADDED" /* ADDED */, path: toPosixPath2(path3.trim()) });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}
async function getClosestGitRepo(path3) {
  let current = path2.resolve(path3);
  if ((await promises.stat(current).catch(() => null))?.isFile()) {
    current = path2.dirname(current);
  }
  while (true) {
    if (await exists(path2.join(current, ".git"))) {
      return current;
    }
    const parent = path2.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
async function getGitDiff(filePath, ref) {
  const path3 = path2.resolve(filePath);
  const info = await promises.stat(path3).catch(() => null);
  if (info === null) {
    throw new GitPathError(`File does not exist: ${path3}`);
  }
  if (info.size > MAX_FILE_SIZE_FOR_GIT_DIFF) {
    throw new GitPathError(`File too large for git diff: ${info.size} bytes (max: ${MAX_FILE_SIZE_FOR_GIT_DIFF} bytes)`);
  }
  const repo = await getClosestGitRepo(path3);
  if (repo === null) {
    throw new GitRepositoryError(`File is not in a git repository: ${path3}`);
  }
  const validRepo = await validateGitRepository(repo);
  const base = await getValidRef(validRepo, ref);
  const relative2 = toPosixPath2(path3.slice(validRepo.length + 1));
  const original = await runGitCommand(["git", "show", `${base}:${relative2}`], { cwd: validRepo }).catch(() => "");
  const modified = (await promises.readFile(path3, "utf8")).split(/\r?\n/u).join("\n").replace(/\n$/u, "");
  return { modified, original };
}
function isGitUrl(source) {
  return source.startsWith("https://") || source.startsWith("http://") || source.startsWith("git://") || source.startsWith("file://") || /^[\w.-]+@[\w.-]+:/u.test(source);
}
function normalizeGitUrl(url) {
  if ((url.startsWith("https://") || url.startsWith("http://")) && !url.endsWith(".git")) {
    return `${url.replace(/\/+$/u, "")}.git`;
  }
  return url;
}
function extractRepoName(source) {
  let name = source;
  for (const prefix of ["github:", "https://", "http://", "git://", "file://"]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  if (name.includes("@") && name.includes(":") && !(name.split(":")[0] ?? "").includes("/")) {
    name = name.split(":", 2)[1] ?? name;
  }
  name = (name.replace(/\/+$/u, "").replace(/\.git$/u, "").split("/").at(-1) ?? "").replace(/[^a-zA-Z0-9_-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  return (name || "repo").slice(0, 32);
}
function mapGitStatus(status) {
  if (status === "M" || status === "*" || status === "U") {
    return "UPDATED" /* UPDATED */;
  }
  if (status === "A" || status === "??") {
    return "ADDED" /* ADDED */;
  }
  if (status === "D") {
    return "DELETED" /* DELETED */;
  }
  throw new GitCommandError(`Unexpected git status: ${status}`, ["git", "diff", "--name-status"], 0, `Unexpected status code: ${status}`);
}
async function repoHasCommits(repoDir) {
  try {
    return await runGitCommand(["git", "--no-pager", "rev-list", "--count", "--all"], { cwd: repoDir }) !== "0";
  } catch {
    return false;
  }
}
async function exists(path3) {
  try {
    await promises.access(path3);
    return true;
  } catch {
    return false;
  }
}
function toPosixPath2(path3) {
  return path3.split(path2.sep).join(path2.posix.sep);
}
function redactUrlCredentials2(value) {
  return value.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1<redacted>@");
}
function redactUrlCredentialsInText2(value) {
  return value.split(/\s+/u).map(redactUrlCredentials2).join(" ");
}
function isExecError2(error) {
  return typeof error === "object" && error !== null && "stderr" in error;
}

// src/extensions/index.ts
var ExtensionFetchError = class extends Error {
};
function parseExtensionSource(source) {
  const value = source.trim();
  if (value.startsWith("github:")) {
    const repo = value.slice("github:".length);
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) {
      throw new ExtensionFetchError(`Invalid GitHub shorthand format: ${value}. Expected format: github:owner/repo`);
    }
    return { type: "github", url: `https://github.com/${repo}.git` };
  }
  if (isGitUrl(value)) {
    return { type: "git", url: normalizeGitUrl(value) };
  }
  if (isLocalPathSource2(value) || value.includes("/") && !value.includes("://")) {
    return { type: "local", url: value };
  }
  throw new ExtensionFetchError(`Unable to parse extension source: ${value}`);
}
function getCachePath(source, cacheDir) {
  const parsed = parseExtensionSource(source);
  const repoName = parsed.type === "local" ? path2.basename(parsed.url.replace(/\/+$/u, "")) || "extension" : extractRepoName(parsed.url);
  const digest = crypto.createHash("sha256").update(parsed.url).digest("hex").slice(0, 12);
  return path2.join(cacheDir, `${repoName}-${digest}`);
}
async function fetchWithResolution(source, cacheDir, options = {}) {
  const parsed = parseExtensionSource(source);
  if (parsed.type === "local") {
    if (options.repoPath !== void 0 && options.repoPath !== null) {
      throw new ExtensionFetchError("repoPath is not supported for local extension sources. Specify the full path directly.");
    }
    return { path: await resolveLocalSource(parsed.url), resolvedRef: null };
  }
  if (options.gitFetcher === void 0) {
    throw new ExtensionFetchError("Git extension fetching requires an explicit gitFetcher in the TypeScript package");
  }
  await promises.mkdir(cacheDir, { recursive: true });
  const cachePath = getCachePath(source, cacheDir);
  const resolvedRef = await options.gitFetcher(parsed.url, cachePath, { ref: options.ref ?? null, update: options.update ?? true });
  return { path: await applySubpath(cachePath, options.repoPath ?? null), resolvedRef };
}
async function fetchExtension(source, cacheDir, options = {}) {
  return (await fetchWithResolution(source, cacheDir, options)).path;
}
var InstallationInfo = class _InstallationInfo {
  name;
  version;
  description;
  enabled;
  source;
  resolvedRef;
  repoPath;
  installedAt;
  installPath;
  constructor(options) {
    this.name = options.name;
    this.version = options.version ?? "";
    this.description = options.description ?? "";
    this.enabled = options.enabled ?? true;
    this.source = options.source;
    this.resolvedRef = options.resolvedRef ?? null;
    this.repoPath = options.repoPath ?? null;
    this.installedAt = options.installedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    this.installPath = options.installPath;
  }
  static fromExtension(extension, source, installPath, options = {}) {
    return new _InstallationInfo({
      name: extension.name,
      version: extension.version,
      description: extension.description ?? "",
      source,
      installPath,
      resolvedRef: options.resolvedRef ?? null,
      repoPath: options.repoPath ?? null
    });
  }
  toJSON() {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      enabled: this.enabled,
      source: this.source,
      resolvedRef: this.resolvedRef,
      repoPath: this.repoPath,
      installedAt: this.installedAt,
      installPath: this.installPath
    };
  }
};
var InstallationMetadata = class _InstallationMetadata {
  static metadataFilename = ".installed.json";
  extensions;
  constructor(options = {}) {
    this.extensions = normalizeInfoMap({ ...options.plugins ?? {}, ...options.skills ?? {}, ...options.extensions ?? {} });
  }
  static metadataPath(installedDir) {
    return path2.join(installedDir, _InstallationMetadata.metadataFilename);
  }
  static async loadFromDir(installedDir) {
    try {
      const raw = JSON.parse(await promises.readFile(_InstallationMetadata.metadataPath(installedDir), "utf8"));
      if (isRecord4(raw)) {
        return new _InstallationMetadata(raw);
      }
    } catch {
      return new _InstallationMetadata();
    }
    return new _InstallationMetadata();
  }
  async saveToDir(installedDir) {
    const path3 = _InstallationMetadata.metadataPath(installedDir);
    await promises.mkdir(path2.dirname(path3), { recursive: true });
    await promises.writeFile(path3, `${JSON.stringify({ extensions: this.extensions }, null, 2)}
`);
  }
  validateTracked(installedDir) {
    const valid = [];
    for (const [name, info] of Object.entries({ ...this.extensions })) {
      try {
        validateExtensionName(name);
      } catch {
        delete this.extensions[name];
        continue;
      }
      if (fs.existsSync(path2.join(installedDir, name))) {
        valid.push(info);
      } else {
        delete this.extensions[name];
      }
    }
    return valid;
  }
  async discoverUntracked(installedDir, loadFromDir) {
    const discovered = [];
    for (const item of await promises.readdir(installedDir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith(".") || this.extensions[item.name] !== void 0) {
        continue;
      }
      validateExtensionName(item.name);
      const dir = path2.join(installedDir, item.name);
      const extension = await loadFromDir(dir);
      const info = InstallationInfo.fromExtension(extension, "local", dir);
      this.extensions[item.name] = info;
      discovered.push(info);
    }
    return discovered;
  }
};
function validateExtensionName(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error(`Invalid extension name. Expected kebab-case, got ${JSON.stringify(name)}.`);
  }
}
function normalizeInfoMap(map) {
  const result = {};
  for (const [name, info] of Object.entries(map)) {
    result[name] = info instanceof InstallationInfo ? info : new InstallationInfo({ ...info, name: info.name ?? name });
  }
  return result;
}
async function resolveLocalSource(source) {
  const expanded = source.startsWith("~/") ? path2.join(os.homedir(), source.slice(2)) : source;
  const path3 = path2.resolve(expanded);
  if (!await exists2(path3)) {
    throw new ExtensionFetchError(`Local extension path does not exist: ${path3}`);
  }
  return path3;
}
async function applySubpath(basePath, subpath) {
  if (subpath === null || subpath.length === 0) {
    return basePath;
  }
  const finalPath = path2.resolve(basePath, subpath.replace(/^\/+|\/+$/gu, ""));
  if (!await exists2(finalPath)) {
    throw new ExtensionFetchError(`Subdirectory '${subpath}' not found in extension repository`);
  }
  return finalPath;
}
async function exists2(path3) {
  try {
    await promises.access(path3);
    return true;
  } catch {
    return false;
  }
}
function isLocalPathSource2(source) {
  return source.startsWith("/") || source.startsWith("~/") || source.startsWith("./") || source.startsWith("../") || /^[a-zA-Z]:[\\/]/u.test(source);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var HookEventType = /* @__PURE__ */ ((HookEventType2) => {
  HookEventType2["PreToolUse"] = "PreToolUse";
  HookEventType2["PostToolUse"] = "PostToolUse";
  HookEventType2["UserPromptSubmit"] = "UserPromptSubmit";
  HookEventType2["SessionStart"] = "SessionStart";
  HookEventType2["SessionEnd"] = "SessionEnd";
  HookEventType2["Stop"] = "Stop";
  return HookEventType2;
})(HookEventType || {});
var HookDecision = /* @__PURE__ */ ((HookDecision2) => {
  HookDecision2["Allow"] = "allow";
  HookDecision2["Deny"] = "deny";
  return HookDecision2;
})(HookDecision || {});
var HookType = /* @__PURE__ */ ((HookType2) => {
  HookType2["Command"] = "command";
  HookType2["Prompt"] = "prompt";
  HookType2["Agent"] = "agent";
  return HookType2;
})(HookType || {});
var hookEventFieldNames = ["pre_tool_use", "post_tool_use", "user_prompt_submit", "session_start", "session_end", "stop"];
var recordSchema2 = zod.z.record(zod.z.string(), zod.z.unknown());
var hookEventSchema = zod.z.object({
  event_type: zod.z.nativeEnum(HookEventType),
  tool_name: zod.z.string().nullable().default(null),
  tool_input: recordSchema2.nullable().default(null),
  tool_response: recordSchema2.nullable().default(null),
  message: zod.z.string().nullable().default(null),
  session_id: zod.z.string().nullable().default(null),
  working_dir: zod.z.string().nullable().default(null),
  metadata: recordSchema2.default({})
}).strict();
var HookDefinition = class {
  type;
  name;
  command;
  prompt;
  system_prompt;
  tools;
  timeout;
  max_iterations;
  async_;
  constructor(options) {
    this.type = hookType(options.type ?? "command" /* Command */);
    this.name = options.name ?? null;
    this.command = options.command ?? "";
    this.prompt = options.prompt ?? null;
    this.system_prompt = options.system_prompt ?? null;
    this.tools = [...options.tools ?? []];
    this.timeout = options.timeout ?? 60;
    this.max_iterations = options.max_iterations ?? 3;
    this.async_ = options.async_ ?? options.async ?? false;
    this.validate();
  }
  get displayCommand() {
    if (this.command.length > 0) {
      return this.command;
    }
    if (this.name !== null) {
      return `agent-hook:${this.name}`;
    }
    if (this.system_prompt !== null && this.system_prompt.length > 0) {
      return `agent-hook:${this.system_prompt.slice(0, 20)}`;
    }
    return "agent-hook:agent";
  }
  toJSON() {
    return { type: this.type, name: this.name, command: this.command, prompt: this.prompt, system_prompt: this.system_prompt, tools: this.tools, timeout: this.timeout, max_iterations: this.max_iterations, async: this.async_ };
  }
  validate() {
    if (this.type === "command" /* Command */ && this.command.length === 0) {
      throw new Error("'command' is required when type is 'command'");
    }
    if (this.type === "prompt" /* Prompt */ && this.prompt === null) {
      throw new Error("'prompt' is required when type is 'prompt'");
    }
    if (this.type === "agent" /* Agent */ && this.command.length > 0) {
      throw new Error("'command' must not be set when type is 'agent'; use 'system_prompt' instead");
    }
    if (this.type === "agent" /* Agent */ && this.async_) {
      throw new Error("'async' is not supported for agent hooks");
    }
  }
};
var HookMatcher = class {
  matcher;
  hooks;
  constructor(options = {}) {
    this.matcher = options.matcher ?? "*";
    this.hooks = [...options.hooks ?? []].map((hook) => hook instanceof HookDefinition ? hook : new HookDefinition(hook));
  }
  matches(toolName) {
    if (this.matcher === "*" || this.matcher === "") {
      return true;
    }
    if (toolName === null || toolName === void 0) {
      return false;
    }
    if (this.matcher.startsWith("/") && this.matcher.endsWith("/") && this.matcher.length > 2) {
      return safeFullMatch(this.matcher.slice(1, -1), toolName) ?? false;
    }
    if (hasRegexMetacharacter(this.matcher)) {
      const matched = safeFullMatch(this.matcher, toolName);
      if (matched !== null) {
        return matched;
      }
    }
    return this.matcher === toolName;
  }
  toJSON() {
    return { matcher: this.matcher, hooks: this.hooks.map((hook) => hook.toJSON()) };
  }
};
var HookConfig = class _HookConfig {
  pre_tool_use;
  post_tool_use;
  user_prompt_submit;
  session_start;
  session_end;
  stop;
  constructor(input = {}) {
    const normalized = normalizeHookConfigInput(input);
    this.pre_tool_use = matchersFor(normalized.pre_tool_use);
    this.post_tool_use = matchersFor(normalized.post_tool_use);
    this.user_prompt_submit = matchersFor(normalized.user_prompt_submit);
    this.session_start = matchersFor(normalized.session_start);
    this.session_end = matchersFor(normalized.session_end);
    this.stop = matchersFor(normalized.stop);
  }
  static fromObject(input) {
    return new _HookConfig(input);
  }
  static async load(options = {}) {
    let path3 = options.path ?? null;
    if (path3 === null) {
      const base = options.workingDir ?? process.cwd();
      for (const candidate of [path2.join(base, ".openhands", "hooks.json"), path2.join(os.homedir(), ".openhands", "hooks.json")]) {
        if (await existsFile2(candidate)) {
          path3 = candidate;
          break;
        }
      }
    }
    if (path3 === null || !await existsFile2(path3)) {
      return new _HookConfig();
    }
    return new _HookConfig(JSON.parse(await promises.readFile(path3, "utf8")));
  }
  isEmpty() {
    return hookEventFieldNames.every((field) => this[field].length === 0);
  }
  getHooksForEvent(eventType, toolName) {
    return this.matchersForEvent(eventType).flatMap((matcher) => matcher.matches(toolName) ? matcher.hooks : []);
  }
  hasHooksForEvent(eventType) {
    return this.matchersForEvent(eventType).length > 0;
  }
  async save(path3) {
    await promises.mkdir(path2.dirname(path3), { recursive: true });
    await promises.writeFile(path3, JSON.stringify(this.toJSON(), null, 2));
  }
  toJSON() {
    return Object.fromEntries(hookEventFieldNames.map((field) => [field, this[field].map((matcher) => matcher.toJSON())]));
  }
  static merge(configs) {
    if (configs.length === 0) {
      return null;
    }
    const merged = new _HookConfig(Object.fromEntries(hookEventFieldNames.map((field) => [field, configs.flatMap((config) => config[field])])));
    return merged.isEmpty() ? null : merged;
  }
  matchersForEvent(eventType) {
    return this[eventTypeToFieldName(eventType)];
  }
};
var HookResult = class {
  success;
  blocked;
  exit_code;
  stdout;
  stderr;
  decision;
  reason;
  additionalContext;
  error;
  asyncStarted;
  constructor(options = {}) {
    this.success = options.success ?? true;
    this.blocked = options.blocked ?? false;
    this.exit_code = options.exit_code ?? 0;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.decision = options.decision ?? null;
    this.reason = options.reason ?? null;
    this.additionalContext = options.additionalContext ?? null;
    this.error = options.error ?? null;
    this.asyncStarted = options.asyncStarted ?? false;
  }
  get shouldContinue() {
    return !this.blocked && this.decision !== "deny" /* Deny */;
  }
};
var AsyncProcessManager = class {
  processes = [];
  addProcess(process2, timeoutSeconds) {
    this.processes.push({ process: process2, startedAt: Date.now(), timeoutMs: timeoutSeconds * 1e3 });
  }
  cleanupExpired() {
    const now = Date.now();
    for (let index = this.processes.length - 1; index >= 0; index -= 1) {
      const tracked = this.processes[index];
      if (tracked === void 0) {
        continue;
      }
      if (tracked.process.exitCode !== null || tracked.process.killed) {
        this.processes.splice(index, 1);
      } else if (now - tracked.startedAt > tracked.timeoutMs) {
        tracked.process.kill("SIGTERM");
        this.processes.splice(index, 1);
      }
    }
  }
  cleanupAll() {
    for (const tracked of this.processes) {
      if (tracked.process.exitCode === null && !tracked.process.killed) {
        tracked.process.kill("SIGTERM");
      }
    }
    this.processes.length = 0;
  }
};
var HookExecutor = class {
  workingDir;
  asyncProcessManager;
  constructor(options = {}) {
    this.workingDir = options.workingDir ?? process.cwd();
    this.asyncProcessManager = options.asyncProcessManager ?? new AsyncProcessManager();
  }
  async execute(hook, event, env) {
    if (hook.type !== "command" /* Command */) {
      return new HookResult({ success: false, decision: "allow" /* Allow */, reason: `${hook.type} hooks are not implemented`, error: `${hook.type} hooks are not implemented` });
    }
    this.asyncProcessManager.cleanupExpired();
    const hookEnv = { ...process.env, OPENHANDS_PROJECT_DIR: this.workingDir, OPENHANDS_SESSION_ID: event.session_id ?? "", OPENHANDS_EVENT_TYPE: event.event_type, ...event.tool_name === null ? {} : { OPENHANDS_TOOL_NAME: event.tool_name }, ...env };
    const eventJson = JSON.stringify(event);
    if (hook.async_) {
      return this.executeAsyncCommand(hook, eventJson, hookEnv);
    }
    return this.executeCommand(hook, eventJson, hookEnv);
  }
  async executeAll(hooks, event, env, stopOnBlock = true) {
    const results = [];
    for (const hook of hooks) {
      const result = await this.execute(hook, event, env);
      results.push(result);
      if (stopOnBlock && result.blocked) {
        break;
      }
    }
    return results;
  }
  executeAsyncCommand(hook, eventJson, env) {
    try {
      const child = child_process.spawn(hook.command, { shell: true, cwd: this.workingDir, env, stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32" });
      child.stdin.write(eventJson);
      child.stdin.end();
      this.asyncProcessManager.addProcess(child, hook.timeout);
      return new HookResult({ success: true, exit_code: 0, asyncStarted: true });
    } catch (error) {
      return new HookResult({ success: false, exit_code: -1, error: `Failed to start async hook: ${String(error)}` });
    }
  }
  executeCommand(hook, eventJson, env) {
    return new Promise((resolve5) => {
      const child = child_process.spawn(hook.command, { shell: true, cwd: this.workingDir, env });
      const stdout = [];
      const stderr = [];
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve5(new HookResult({ success: false, exit_code: -1, error: `Hook timed out after ${hook.timeout} seconds` }));
      }, hook.timeout * 1e3);
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve5(new HookResult({ success: false, exit_code: -1, error: `Hook execution failed: ${error.message}` }));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve5(parseCommandResult(code ?? -1, Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8")));
      });
      child.stdin.write(eventJson);
      child.stdin.end();
    });
  }
};
var HookManager = class {
  config;
  executor;
  sessionId;
  workingDir;
  constructor(options = {}) {
    this.config = options.config ?? new HookConfig();
    this.workingDir = options.workingDir ?? null;
    this.sessionId = options.sessionId ?? null;
    this.executor = options.executor ?? new HookExecutor({ workingDir: this.workingDir });
  }
  async runPreToolUse(toolName, toolInput) {
    const results = await this.executor.executeAll(this.config.getHooksForEvent("PreToolUse" /* PreToolUse */, toolName), this.event("PreToolUse" /* PreToolUse */, { tool_name: toolName, tool_input: toolInput }), void 0, true);
    return { shouldContinue: results.every((result) => result.shouldContinue), results };
  }
  async runPostToolUse(toolName, toolInput, toolResponse) {
    return this.executor.executeAll(this.config.getHooksForEvent("PostToolUse" /* PostToolUse */, toolName), this.event("PostToolUse" /* PostToolUse */, { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }), void 0, false);
  }
  async runUserPromptSubmit(message) {
    const results = await this.executor.executeAll(this.config.getHooksForEvent("UserPromptSubmit" /* UserPromptSubmit */), this.event("UserPromptSubmit" /* UserPromptSubmit */, { message }), void 0, true);
    const context = results.map((result) => result.additionalContext).filter((value) => value !== null && value.length > 0).join("\n");
    return { shouldContinue: results.every((result) => result.shouldContinue), additionalContext: context.length > 0 ? context : null, results };
  }
  async runStop(reason) {
    const results = await this.executor.executeAll(this.config.getHooksForEvent("Stop" /* Stop */), this.event("Stop" /* Stop */, { metadata: reason ? { reason } : {} }), void 0, true);
    return { shouldStop: results.every((result) => result.shouldContinue), results };
  }
  hasHooks(eventType) {
    return this.config.hasHooksForEvent(eventType);
  }
  getBlockingReason(results) {
    for (const result of results) {
      if (result.blocked) {
        return result.reason ?? (result.stderr.trim().length > 0 ? result.stderr.trim() : "Blocked by hook");
      }
    }
    return null;
  }
  cleanupAsyncProcesses() {
    this.executor.asyncProcessManager.cleanupAll();
  }
  event(event_type, overrides = {}) {
    return hookEventSchema.parse({ event_type, session_id: this.sessionId, working_dir: this.workingDir, ...overrides });
  }
};
function parseCommandResult(exitCode, stdout, stderr) {
  const parsed = parseHookStdout(stdout);
  return new HookResult({
    success: exitCode === 0,
    blocked: exitCode === 2 || parsed.blocked,
    exit_code: exitCode,
    stdout,
    stderr,
    decision: parsed.decision,
    reason: parsed.reason,
    additionalContext: parsed.additionalContext
  });
}
function parseHookStdout(stdout) {
  if (stdout.trim().length === 0) {
    return { decision: null, reason: null, additionalContext: null, blocked: false };
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!isRecord5(parsed)) {
      return { decision: null, reason: null, additionalContext: null, blocked: false };
    }
    const decision = parsed.decision === "allow" /* Allow */ ? "allow" /* Allow */ : parsed.decision === "deny" /* Deny */ ? "deny" /* Deny */ : null;
    return {
      decision,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      additionalContext: typeof parsed.additionalContext === "string" ? parsed.additionalContext : null,
      blocked: decision === "deny" /* Deny */ || parsed.continue === false
    };
  } catch {
    return { decision: null, reason: null, additionalContext: null, blocked: false };
  }
}
function normalizeHookConfigInput(input) {
  const raw = input.hooks === void 0 ? input : input.hooks;
  const normalized = {};
  const seen = /* @__PURE__ */ new Set();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "hooks") {
      continue;
    }
    const field = hookKeyToFieldName(key);
    if (seen.has(field)) {
      throw new Error(`Duplicate hook event: both '${key}' and its snake_case equivalent '${field}' were provided`);
    }
    seen.add(field);
    normalized[field] = value;
  }
  return normalized;
}
function hookKeyToFieldName(key) {
  const candidate = key.includes("_") ? key : pascalToSnake(key);
  if (hookEventFieldNames.includes(candidate)) {
    return candidate;
  }
  throw new Error(`Unknown event type '${key}'. Valid types: ${hookEventFieldNames.join(", ")}`);
}
function eventTypeToFieldName(eventType) {
  return hookKeyToFieldName(eventType);
}
function pascalToSnake(name) {
  let output = "";
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    output += isUpper && output.length > 0 ? `_${character.toLowerCase()}` : character.toLowerCase();
  }
  return output;
}
function matchersFor(input) {
  return [...input ?? []].map((matcher) => matcher instanceof HookMatcher ? matcher : new HookMatcher(matcher));
}
function hookType(value) {
  if (value === "command" /* Command */ || value === "prompt" /* Prompt */ || value === "agent" /* Agent */) {
    return value;
  }
  throw new Error(`Unknown hook type: ${String(value)}`);
}
function hasRegexMetacharacter(value) {
  for (const character of value) {
    if ("|.*+?[]()^$".includes(character)) {
      return true;
    }
  }
  return false;
}
function safeFullMatch(pattern, value) {
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return null;
  }
}
async function existsFile2(path3) {
  try {
    return (await promises.stat(path3)).isFile();
  } catch {
    return false;
  }
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/llm/provider-quirks.ts
var ANTHROPIC_THINKING_MIN_BUDGET = 1024;
var ANTHROPIC_THINKING_MAX_BUDGET = 128e3;
var PROMPT_CACHE_MODELS = [
  "claude-3-7-sonnet",
  "claude-sonnet-3-7-latest",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-haiku",
  "claude-3-opus",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7"
];
function isGpt5Model(model) {
  return model?.trim().toLowerCase().includes("gpt-5") === true;
}
function isGpt56Model(model) {
  const normalized = model?.trim().toLowerCase().replace(/^openai\//u, "") ?? "";
  return /^gpt-5\.6(?:[-.]|$)/u.test(normalized);
}
function isOpenAISubscriptionEndpoint(profile) {
  const baseUrl = profile.baseUrl?.trim().toLowerCase() ?? "";
  return baseUrl.includes("chatgpt.com/backend-api/codex");
}
function supportsOpenAIPromptCacheRetention(profile) {
  if (profile.providerId !== "openai" || isOpenAISubscriptionEndpoint(profile) || !isGpt56Model(profile.model)) {
    return false;
  }
  const baseUrl = profile.baseUrl?.trim().toLowerCase();
  return baseUrl === void 0 || baseUrl === "" || baseUrl.startsWith("https://api.openai.com/");
}
function resolveOpenAIPromptCacheRetention(profile) {
  if (!supportsOpenAIPromptCacheRetention(profile) || profile.promptCacheRetention === "disabled") {
    return void 0;
  }
  return profile.promptCacheRetention ?? "24h";
}
function resolveOpenAIPromptCacheKey(profile) {
  if (!supportsOpenAIPromptCacheRetention(profile)) {
    return void 0;
  }
  return profile.promptCacheKey ?? void 0;
}
function hasExtendedThinking(profile) {
  return profile.reasoningEffort !== null;
}
function isAnthropicModel(profile) {
  if (profile.providerId === "anthropic") {
    return true;
  }
  const model = profile.model.trim().toLowerCase();
  if (model.startsWith("anthropic/") || model.includes("claude")) {
    return true;
  }
  return profile.baseUrl?.toLowerCase().includes("anthropic.com") === true;
}
function supportsThinkingBlocks(profile) {
  return isAnthropicModel(profile) && hasExtendedThinking(profile);
}
function supportsPromptCaching(profile) {
  if (!isAnthropicModel(profile)) {
    return false;
  }
  const model = profile.model.trim().toLowerCase();
  return PROMPT_CACHE_MODELS.some((needle) => model.includes(needle));
}
function getAnthropicThinkingBudget(profile, maxTokens) {
  if (!supportsThinkingBlocks(profile)) {
    return void 0;
  }
  if (maxTokens <= ANTHROPIC_THINKING_MIN_BUDGET) {
    throw new Error(
      `Anthropic extended thinking requires maxOutputTokens greater than ${ANTHROPIC_THINKING_MIN_BUDGET}; got ${maxTokens}.`
    );
  }
  const targetBudget = Math.floor(maxTokens * 0.8);
  return Math.min(ANTHROPIC_THINKING_MAX_BUDGET, maxTokens - 1, Math.max(ANTHROPIC_THINKING_MIN_BUDGET, targetBudget));
}
function normalizeGenerationParamsForModel(profile) {
  if (isGpt5Model(profile.model)) {
    return { ...profile, temperature: null };
  }
  if (supportsThinkingBlocks(profile)) {
    return { ...profile, temperature: 1 };
  }
  return profile;
}
function toGeminiThinkingLevel(reasoningEffort) {
  if (reasoningEffort === null) {
    return void 0;
  }
  switch (reasoningEffort) {
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
}

// src/llm/anthropic.ts
var DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
var DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
var DEFAULT_MAX_TOKENS = 4096;
var AnthropicMessagesClient = class {
  profile;
  apiKey;
  fetchImpl;
  constructor(profile, apiKey, fetchImpl = defaultFetch) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  async complete(messages) {
    const body = buildAnthropicMessagesBody(this.profile, messages);
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/v1/messages`, {
      method: "POST",
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic messages completion failed with HTTP ${response.status}: ${text}`);
    }
    return parseAnthropicMessagesResponse(await response.json());
  }
};
async function createAnthropicClientFromProfile(profile, store, options = {}) {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride
    },
    store
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for Anthropic LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`
    );
  }
  return new AnthropicMessagesClient(profile, apiKey, options.fetch ?? defaultFetch);
}
function buildAnthropicMessagesBody(profile, messages) {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const systemMessages = parsedMessages.filter((message) => message.role === "system");
  const system = systemMessages.flatMap((message) => contentToString(message.content));
  const shouldCacheSystem = supportsPromptCaching(normalizedProfile) && systemMessages.some((message) => message.content.some((content) => content.cache_prompt));
  const maxTokens = normalizedProfile.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const thinkingBudget = getAnthropicThinkingBudget(normalizedProfile, maxTokens);
  const body = {
    model: normalizedProfile.model,
    max_tokens: maxTokens,
    messages: parsedMessages.filter((message) => message.role !== "system").map((message) => toAnthropicMessage(normalizedProfile, message))
  };
  if (system.length > 0) {
    body.system = shouldCacheSystem ? [{ type: "text", text: system.join("\n"), cache_control: { type: "ephemeral" } }] : system.join("\n");
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.topK !== null) {
    body.top_k = normalizedProfile.topK;
  }
  if (thinkingBudget !== void 0) {
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }
  return body;
}
function toAnthropicMessage(profile, message) {
  if (message.role === "assistant") {
    return { role: "assistant", content: toAnthropicAssistantContent(message) };
  }
  if (message.role === "tool") {
    return { role: "user", content: [toAnthropicToolResultBlock(message)] };
  }
  return {
    role: "user",
    content: message.content.map((content) => toAnthropicContentBlock(profile, content))
  };
}
function toAnthropicAssistantContent(message) {
  const blocks = [];
  const thinkingBlock = message.thinking_blocks.find(
    (block) => block.type === "thinking" && block.signature !== null
  );
  if (thinkingBlock !== void 0) {
    blocks.push({ type: "thinking", thinking: thinkingBlock.thinking, signature: thinkingBlock.signature });
  }
  const text = reduceTextContent(message);
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }
  if (message.tool_calls !== null) {
    blocks.push(...message.tool_calls.map(toAnthropicToolUseBlock));
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
function toAnthropicToolUseBlock(toolCall) {
  return {
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.name,
    input: parseToolArguments2(toolCall.arguments)
  };
}
function toAnthropicToolResultBlock(message) {
  const block = {
    type: "tool_result",
    tool_use_id: message.tool_call_id ?? "",
    content: reduceTextContent(message)
  };
  return block;
}
function toAnthropicContentBlock(profile, content) {
  const block = content.type === "text" ? { type: "text", text: content.text } : {
    type: "image",
    source: {
      type: "url",
      url: content.image_urls[0] ?? ""
    }
  };
  if (content.cache_prompt && supportsPromptCaching(profile)) {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}
function parseToolArguments2(args) {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
function parseAnthropicMessagesResponse(raw) {
  const parsed = anthropicMessagesResponseSchema.parse(raw);
  const text = parsed.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const thinkingBlocks = parsed.content.filter((block) => block.type === "thinking");
  const reasoningContent = thinkingBlocks.map((block) => block.thinking).join("");
  return llmCompletionResponseSchema.parse({
    message: {
      role: "assistant",
      content: text,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thinkingBlocks.map((block) => ({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature ?? null
      }))
    },
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens
    },
    raw
  });
}
function resolveBaseUrl(profile) {
  return (profile.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, "");
}
function buildHeaders(profile, apiKey) {
  return {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
    ...profile.headers
  };
}
async function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}
var anthropicTextBlockSchema = zod.z.object({ type: zod.z.literal("text"), text: zod.z.string() }).passthrough();
var anthropicThinkingBlockSchema = zod.z.object({ type: zod.z.literal("thinking"), thinking: zod.z.string(), signature: zod.z.string().nullable().optional() }).passthrough();
var anthropicOtherBlockSchema = zod.z.object({ type: zod.z.string() }).passthrough();
var anthropicContentBlockSchema = zod.z.union([anthropicTextBlockSchema, anthropicThinkingBlockSchema, anthropicOtherBlockSchema]);
var anthropicMessagesResponseSchema = zod.z.object({
  role: zod.z.literal("assistant").default("assistant"),
  content: zod.z.array(anthropicContentBlockSchema),
  usage: zod.z.object({
    input_tokens: zod.z.number().int().min(0).default(0),
    output_tokens: zod.z.number().int().min(0).default(0)
  }).passthrough().nullable().default(null)
}).passthrough();
var DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
var GeminiClient = class {
  profile;
  apiKey;
  fetchImpl;
  constructor(profile, apiKey, fetchImpl = defaultFetch2) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  async complete(messages) {
    const response = await this.fetchImpl(`${resolveBaseUrl2(this.profile)}/models/${encodeURIComponent(this.profile.model)}:generateContent`, {
      method: "POST",
      headers: buildHeaders2(this.profile, this.apiKey),
      body: JSON.stringify(buildGeminiGenerateContentBody(this.profile, messages))
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini generateContent failed with HTTP ${response.status}: ${text}`);
    }
    return parseGeminiGenerateContentResponse(await response.json());
  }
};
async function createGeminiClientFromProfile(profile, store, options = {}) {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride
    },
    store
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for Gemini LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`
    );
  }
  return new GeminiClient(profile, apiKey, options.fetch ?? defaultFetch2);
}
function buildGeminiGenerateContentBody(profile, messages) {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const system = parsedMessages.filter((message) => message.role === "system").flatMap((message) => contentToString(message.content));
  const body = {
    contents: parsedMessages.filter((message) => message.role !== "system").map(toGeminiContent)
  };
  if (system.length > 0) {
    body.systemInstruction = { parts: system.map((text) => ({ text })) };
  }
  const generationConfig = buildGenerationConfig(normalizedProfile);
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}
function toGeminiContent(message) {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{ functionResponse: { name: message.name ?? "unknown_tool", response: { content: contentToString(message.content).join("\n") } } }]
    };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: toGeminiParts(message)
  };
}
function toGeminiParts(message) {
  const signature = firstThinkingSignature(message);
  const parts = message.content.flatMap((content) => {
    if (content.type === "text" && content.text.length === 0) {
      return [];
    }
    return [toGeminiPart(content, signature)];
  });
  if (message.tool_calls !== null) {
    parts.push(...message.tool_calls.map((toolCall, index) => toGeminiFunctionCallPart(toolCall, index === 0 ? signature : null)));
  }
  return parts;
}
function toGeminiPart(content, thoughtSignature) {
  if (content.type === "text") {
    const part = { text: content.text };
    if (thoughtSignature !== null) {
      part.thoughtSignature = thoughtSignature;
    }
    return part;
  }
  return { fileData: { fileUri: content.image_urls[0] ?? "" } };
}
function toGeminiFunctionCallPart(toolCall, thoughtSignature) {
  const part = { functionCall: { name: toolCall.name, args: parseToolArguments3(toolCall.arguments) } };
  if (thoughtSignature !== null) {
    part.thoughtSignature = thoughtSignature;
  }
  return part;
}
function buildGenerationConfig(profile) {
  const config = {};
  if (profile.temperature !== null) {
    config.temperature = profile.temperature;
  }
  if (profile.topP !== null) {
    config.topP = profile.topP;
  }
  if (profile.topK !== null) {
    config.topK = profile.topK;
  }
  if (profile.maxOutputTokens !== null) {
    config.maxOutputTokens = profile.maxOutputTokens;
  }
  const thinkingLevel = toGeminiThinkingLevel(profile.reasoningEffort);
  if (thinkingLevel !== void 0) {
    config.thinkingConfig = { thinkingLevel, includeThoughts: true };
  }
  return config;
}
function parseGeminiGenerateContentResponse(raw) {
  const parsed = geminiGenerateContentResponseSchema.parse(raw);
  const firstCandidate = parsed.candidates[0];
  if (firstCandidate === void 0) {
    throw new Error("Gemini generateContent returned no candidates.");
  }
  const parts = firstCandidate.content.parts;
  const text = parts.flatMap((part) => part.text === void 0 || part.text.length === 0 || part.thought === true ? [] : [part.text]).join("\n");
  const reasoningContent = parts.flatMap((part) => part.text === void 0 || part.text.length === 0 || part.thought !== true ? [] : [part.text]).join("");
  const thoughtSignature = parts.find((part) => part.thoughtSignature !== void 0)?.thoughtSignature ?? null;
  const toolCalls = parts.flatMap((part, index) => part.functionCall === void 0 ? [] : [fromGeminiFunctionCall(part.functionCall, index)]);
  const promptTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = parsed.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;
  return llmCompletionResponseSchema.parse({
    message: {
      role: "assistant",
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thoughtSignature === null ? [] : [{ type: "thinking", thinking: reasoningContent, signature: thoughtSignature }]
    },
    usage: { promptTokens, completionTokens, totalTokens },
    raw
  });
}
function firstThinkingSignature(message) {
  return message.thinking_blocks.find(
    (block) => block.type === "thinking" && block.signature !== null
  )?.signature ?? null;
}
function parseToolArguments3(args) {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
function fromGeminiFunctionCall(functionCall, index) {
  return {
    id: `gemini_call_${index}`,
    responses_item_id: null,
    name: functionCall.name,
    arguments: JSON.stringify(functionCall.args ?? {}),
    origin: "completion"
  };
}
function resolveBaseUrl2(profile) {
  return (profile.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/u, "");
}
function buildHeaders2(profile, apiKey) {
  return {
    "x-goog-api-key": apiKey,
    "content-type": "application/json",
    ...profile.headers
  };
}
async function defaultFetch2(url, init) {
  return globalThis.fetch(url, init);
}
var geminiFunctionCallSchema = zod.z.object({ name: zod.z.string(), args: zod.z.unknown().optional() }).passthrough();
var geminiPartSchema = zod.z.object({
  text: zod.z.string().optional(),
  thought: zod.z.boolean().optional(),
  thoughtSignature: zod.z.string().optional(),
  functionCall: geminiFunctionCallSchema.optional()
}).passthrough();
var geminiGenerateContentResponseSchema = zod.z.object({
  candidates: zod.z.array(
    zod.z.object({
      content: zod.z.object({
        role: zod.z.string().default("model"),
        parts: zod.z.array(geminiPartSchema).default([])
      }).passthrough()
    }).passthrough()
  ),
  usageMetadata: zod.z.object({
    promptTokenCount: zod.z.number().int().min(0).optional(),
    candidatesTokenCount: zod.z.number().int().min(0).optional(),
    totalTokenCount: zod.z.number().int().min(0).optional()
  }).passthrough().optional()
}).passthrough();
var DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
var OpenAIChatClient = class {
  profile;
  apiKey;
  fetchImpl;
  constructor(profile, apiKey, fetchImpl = defaultFetch3) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  async complete(messages, tools) {
    const body = buildChatCompletionsBody(this.profile, messages, tools);
    const response = await this.fetchImpl(`${resolveBaseUrl3(this.profile)}/chat/completions`, {
      method: "POST",
      headers: buildHeaders3(this.profile, this.apiKey),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI-compatible completion failed with HTTP ${response.status}: ${text}`);
    }
    return parseChatCompletionsResponse(await response.json());
  }
};
var OpenAIResponsesClient = class {
  profile;
  apiKey;
  fetchImpl;
  constructor(profile, apiKey, fetchImpl = defaultFetch3) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  async complete(messages, tools) {
    const response = await this.fetchImpl(`${resolveBaseUrl3(this.profile)}/responses`, {
      method: "POST",
      headers: buildHeaders3(this.profile, this.apiKey),
      body: JSON.stringify(buildOpenAIResponsesBody(this.profile, messages, tools))
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI Responses completion failed with HTTP ${response.status}: ${text}`);
    }
    return parseOpenAIResponsesResponse(await response.json());
  }
};
async function createOpenAIChatClientFromProfile(profile, store, options = {}) {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride
    },
    store
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`
    );
  }
  return new OpenAIChatClient(profile, apiKey, options.fetch ?? defaultFetch3);
}
async function createOpenAIResponsesClientFromProfile(profile, store, options = {}) {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride
    },
    store
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`
    );
  }
  return new OpenAIResponsesClient(profile, apiKey, options.fetch ?? defaultFetch3);
}
function applyOpenAIPromptCacheOptions(body, profile) {
  const retention = resolveOpenAIPromptCacheRetention(profile);
  if (retention !== void 0) {
    body.prompt_cache_retention = retention;
  }
  const cacheKey = resolveOpenAIPromptCacheKey(profile);
  if (cacheKey !== void 0) {
    body.prompt_cache_key = cacheKey;
  }
}
function buildChatCompletionsBody(profile, messages, tools = []) {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const body = {
    model: normalizedProfile.model,
    messages: messages.map((message) => toOpenAIChatMessage(messageSchema.parse(message)))
  };
  if (tools.length > 0) {
    body.tools = tools.map(toOpenAIChatTool);
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.maxOutputTokens !== null) {
    body.max_completion_tokens = normalizedProfile.maxOutputTokens;
  }
  if (normalizedProfile.timeoutSeconds !== null) {
    body.timeout = normalizedProfile.timeoutSeconds;
  }
  if (normalizedProfile.reasoningEffort !== null) {
    body.reasoning_effort = normalizedProfile.reasoningEffort;
  }
  applyOpenAIPromptCacheOptions(body, normalizedProfile);
  return body;
}
function buildOpenAIResponsesBody(profile, messages, tools = []) {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const instructions = parsedMessages.filter((message) => message.role === "system").flatMap((message) => contentToString(message.content));
  const body = {
    model: normalizedProfile.model,
    input: parsedMessages.filter((message) => message.role !== "system").flatMap(toOpenAIResponsesInputItems),
    include: ["reasoning.encrypted_content"],
    store: false
  };
  if (instructions.length > 0) {
    body.instructions = instructions.join("\n");
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => tool.toResponsesTool());
  }
  if (normalizedProfile.maxOutputTokens !== null) {
    body.max_output_tokens = normalizedProfile.maxOutputTokens;
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.reasoningEffort !== null || normalizedProfile.reasoningSummary !== null) {
    body.reasoning = {
      ...normalizedProfile.reasoningEffort === null ? {} : { effort: normalizedProfile.reasoningEffort },
      ...normalizedProfile.reasoningSummary === null ? {} : { summary: normalizedProfile.reasoningSummary }
    };
  }
  applyOpenAIPromptCacheOptions(body, normalizedProfile);
  return body;
}
function toOpenAIResponsesInputItems(message) {
  if (message.role === "user") {
    const content = message.content.map((contentItem) => {
      if (contentItem.type === "text") {
        return { type: "input_text", text: contentItem.text };
      }
      return { type: "input_image", image_url: contentItem.image_urls[0] ?? "", detail: "auto" };
    });
    return [{ type: "message", role: "user", content: content.length > 0 ? content : [{ type: "input_text", text: "" }] }];
  }
  if (message.role === "assistant") {
    const items = [];
    const reasoningItem = toOpenAIResponsesReasoningInputItem(message);
    if (reasoningItem !== null) {
      items.push(reasoningItem);
    }
    const content = message.content.filter((contentItem) => contentItem.type === "text" && contentItem.text.length > 0).map((contentItem) => ({ type: "output_text", text: contentItem.text }));
    if (content.length > 0) {
      items.push({ type: "message", role: "assistant", content });
    }
    if (message.tool_calls !== null) {
      items.push(...message.tool_calls.map(toOpenAIResponsesFunctionCallInputItem));
    }
    return items;
  }
  if (message.role === "tool") {
    return message.content.filter((contentItem) => contentItem.type === "text" && message.tool_call_id !== null).map((contentItem) => ({ type: "function_call_output", call_id: normalizeResponsesCallId(message.tool_call_id ?? ""), output: contentItem.text }));
  }
  return [];
}
function toOpenAIResponsesReasoningInputItem(message) {
  const reasoning = message.responses_reasoning_item;
  if (reasoning === null || reasoning.id === null || reasoning.encrypted_content === null) {
    return null;
  }
  return {
    type: "reasoning",
    id: reasoning.id,
    summary: reasoning.summary.map((text) => ({ type: "summary_text", text })),
    encrypted_content: reasoning.encrypted_content
  };
}
function toOpenAIResponsesFunctionCallInputItem(toolCall) {
  const callId = normalizeResponsesCallId(toolCall.id);
  return {
    type: "function_call",
    id: toolCall.responses_item_id ?? callId,
    call_id: callId,
    name: toolCall.name,
    arguments: toolCall.arguments
  };
}
function normalizeResponsesCallId(value) {
  return value.startsWith("call_") ? value : `call_${value.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
}
function toOpenAIChatTool(tool) {
  const responsesTool = tool.toResponsesTool();
  return {
    type: "function",
    function: {
      name: responsesTool.name,
      description: responsesTool.description,
      parameters: responsesTool.parameters,
      strict: responsesTool.strict
    }
  };
}
function toOpenAIChatMessage(message) {
  const out = {
    role: message.role,
    content: serializeContent(message.content)
  };
  if (message.tool_calls !== null) {
    out.tool_calls = message.tool_calls.map(toOpenAIChatToolCall);
    if (isEmptySerializedContent(out.content)) {
      delete out.content;
    }
  }
  if (message.tool_call_id !== null) {
    out.tool_call_id = message.tool_call_id;
  }
  if (message.name !== null) {
    out.name = message.name;
  }
  return out;
}
function serializeContent(content) {
  if (content.every((item) => item.type === "text")) {
    return contentToString(content).join("\n");
  }
  return content.map((item) => {
    if (item.type === "text") {
      return { type: "text", text: item.text };
    }
    return { type: "image_url", image_url: { url: item.image_urls[0] ?? "" } };
  });
}
function isEmptySerializedContent(content) {
  if (content === "") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((item) => {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      return false;
    }
    const record = item;
    return record.type === "text" && record.text === "";
  });
}
function toOpenAIChatToolCall(toolCall) {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments
    }
  };
}
function parseChatCompletionsResponse(raw) {
  const parsed = openAIChatCompletionResponseSchema.parse(raw);
  const firstChoice = parsed.choices[0];
  if (firstChoice === void 0) {
    throw new Error("OpenAI-compatible completion returned no choices.");
  }
  const message = messageSchema.parse({
    role: firstChoice.message.role,
    content: firstChoice.message.content,
    tool_calls: firstChoice.message.tool_calls?.map(fromOpenAIChatToolCall) ?? null
  });
  return llmCompletionResponseSchema.parse({
    message,
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.prompt_tokens,
      completionTokens: parsed.usage.completion_tokens,
      totalTokens: parsed.usage.total_tokens
    },
    raw
  });
}
function fromOpenAIChatToolCall(toolCall) {
  return {
    id: toolCall.id,
    responses_item_id: null,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    origin: "completion"
  };
}
function parseOpenAIResponsesResponse(raw) {
  const parsed = openAIResponsesResponseSchema.parse(raw);
  const text = parsed.output.filter((item) => item.type === "message").flatMap((item) => item.content).filter((content) => content.type === "output_text").map((content) => content.text).join("\n");
  const reasoningItem = parsed.output.find((item) => item.type === "reasoning") ?? null;
  const toolCalls = parsed.output.filter((item) => item.type === "function_call").map(fromOpenAIResponsesFunctionCall);
  return llmCompletionResponseSchema.parse({
    message: {
      role: "assistant",
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      responses_reasoning_item: reasoningItem === null ? null : {
        id: reasoningItem.id,
        summary: normalizeResponsesReasoningSummary(reasoningItem.summary),
        content: normalizeResponsesReasoningContent(reasoningItem.content),
        encrypted_content: reasoningItem.encrypted_content ?? null,
        status: reasoningItem.status ?? null
      }
    },
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.total_tokens
    },
    raw
  });
}
function fromOpenAIResponsesFunctionCall(item) {
  return {
    id: item.call_id,
    responses_item_id: item.id,
    name: item.name,
    arguments: item.arguments,
    origin: "responses"
  };
}
function normalizeResponsesReasoningSummary(summary) {
  return summary.flatMap((item) => item.text.length === 0 ? [] : [item.text]);
}
function normalizeResponsesReasoningContent(content) {
  if (content === null) {
    return null;
  }
  const values = content.flatMap((item) => {
    if (item.text !== null && item.text.length > 0) {
      return [item.text];
    }
    if (item.content !== null && item.content.length > 0) {
      return [item.content];
    }
    return [];
  });
  return values.length > 0 ? values : null;
}
function resolveBaseUrl3(profile) {
  const baseUrl = profile.baseUrl ?? defaultBaseUrlForProvider(profile.providerId);
  return baseUrl.replace(/\/+$/u, "");
}
function defaultBaseUrlForProvider(providerId) {
  if (providerId === "openrouter") {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  return DEFAULT_OPENAI_BASE_URL;
}
function buildHeaders3(profile, apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...profile.headers
  };
}
async function defaultFetch3(url, init) {
  return globalThis.fetch(url, init);
}
var openAIChatToolCallSchema = zod.z.object({
  id: zod.z.string(),
  type: zod.z.literal("function").default("function"),
  function: zod.z.object({ name: zod.z.string(), arguments: zod.z.string() }).strict()
}).strict();
var openAIChatCompletionResponseSchema = zod.z.object({
  choices: zod.z.array(
    zod.z.object({
      message: zod.z.object({
        role: zod.z.union([zod.z.literal("assistant"), zod.z.literal("tool"), zod.z.literal("user"), zod.z.literal("system")]),
        content: zod.z.string().nullable().default(null),
        tool_calls: zod.z.array(openAIChatToolCallSchema).optional()
      }).passthrough()
    }).passthrough()
  ),
  usage: zod.z.object({
    prompt_tokens: zod.z.number().int().min(0).default(0),
    completion_tokens: zod.z.number().int().min(0).default(0),
    total_tokens: zod.z.number().int().min(0).default(0)
  }).passthrough().nullable().default(null)
}).passthrough();
var openAIResponsesOutputTextSchema = zod.z.object({ type: zod.z.literal("output_text"), text: zod.z.string() }).passthrough();
var openAIResponsesContentItemSchema = zod.z.union([openAIResponsesOutputTextSchema, zod.z.object({ type: zod.z.string() }).passthrough()]);
var openAIResponsesMessageItemSchema = zod.z.object({
  type: zod.z.literal("message"),
  role: zod.z.literal("assistant").default("assistant"),
  content: zod.z.array(openAIResponsesContentItemSchema).default([])
}).passthrough();
var openAIResponsesReasoningSummaryItemSchema = zod.z.object({
  type: zod.z.string().default("summary_text"),
  text: zod.z.string().default("")
}).passthrough();
var openAIResponsesReasoningContentItemSchema = zod.z.object({
  type: zod.z.string().default("reasoning_text"),
  text: zod.z.string().nullable().default(null),
  content: zod.z.string().nullable().default(null)
}).passthrough();
var openAIResponsesReasoningItemSchema = zod.z.object({
  type: zod.z.literal("reasoning"),
  id: zod.z.string().nullable().default(null),
  summary: zod.z.array(openAIResponsesReasoningSummaryItemSchema).default([]),
  content: zod.z.array(openAIResponsesReasoningContentItemSchema).nullable().default(null),
  encrypted_content: zod.z.string().nullable().default(null),
  status: zod.z.string().nullable().default(null)
}).passthrough();
var openAIResponsesFunctionCallItemSchema = zod.z.object({
  type: zod.z.literal("function_call"),
  id: zod.z.string().nullable().default(null),
  call_id: zod.z.string(),
  name: zod.z.string(),
  arguments: zod.z.string().default("{}")
}).passthrough();
var openAIResponsesOutputItemSchema = zod.z.union([
  openAIResponsesMessageItemSchema,
  openAIResponsesReasoningItemSchema,
  openAIResponsesFunctionCallItemSchema,
  zod.z.object({ type: zod.z.string() }).passthrough()
]);
var openAIResponsesResponseSchema = zod.z.object({
  output: zod.z.array(openAIResponsesOutputItemSchema).default([]),
  usage: zod.z.object({
    input_tokens: zod.z.number().int().min(0).default(0),
    output_tokens: zod.z.number().int().min(0).default(0),
    total_tokens: zod.z.number().int().min(0).default(0)
  }).passthrough().nullable().default(null)
}).passthrough();

// src/llm/factory.ts
var DETECTED_LLM_PROVIDERS = ["anthropic", "gemini", "openai", "openrouter", "litellm_proxy"];
async function createClientFromProfile(profile, store, options = {}) {
  const provider = resolveProviderFromProfile(profile);
  if (provider === "anthropic") {
    return createAnthropicClientFromProfile(profile, store, options);
  }
  if (provider === "gemini") {
    return createGeminiClientFromProfile(profile, store, options);
  }
  if (profile.openAiApiMode === "responses") {
    return createOpenAIResponsesClientFromProfile(profile, store, options);
  }
  return createOpenAIChatClientFromProfile(profile, store, options);
}
function resolveProviderFromProfile(profile) {
  const providerId = profile.providerId.toLowerCase();
  if (isDetectedLlmProvider(providerId)) {
    return providerId;
  }
  return detectProviderFromBaseUrl(profile.baseUrl);
}
function detectProviderFromBaseUrl(baseUrl) {
  const normalized = (baseUrl ?? "").toLowerCase();
  if (normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("generativelanguage.googleapis.com") || normalized.includes("ai.google.dev") || normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("openrouter")) {
    return "openrouter";
  }
  if (normalized.includes("litellm") || normalized.includes("llm-proxy")) {
    return "litellm_proxy";
  }
  return "openai";
}
function isDetectedLlmProvider(providerId) {
  return DETECTED_LLM_PROVIDERS.includes(providerId);
}
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 10] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 20] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 30] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 40] = "ERROR";
  LogLevel2[LogLevel2["CRITICAL"] = 50] = "CRITICAL";
  return LogLevel2;
})(LogLevel || {});
var loggerLevels = /* @__PURE__ */ new Map();
var rootLevel = envLogLevel();
function setupLogging(options = {}) {
  rootLevel = options.level ?? envLogLevel();
}
function disableLogger(name, level = 50 /* CRITICAL */) {
  loggerLevels.set(name, level);
}
function isEnabledFor(name, level) {
  return level >= (loggerLevels.get(name) ?? rootLevel);
}
function getLogger(name) {
  return {
    name,
    debug: (message, ...args) => emit(name, 10 /* DEBUG */, message, args),
    info: (message, ...args) => emit(name, 20 /* INFO */, message, args),
    warn: (message, ...args) => emit(name, 30 /* WARN */, message, args),
    error: (message, ...args) => emit(name, 40 /* ERROR */, message, args)
  };
}
function emit(name, level, message, args) {
  if (!isEnabledFor(name, level)) {
    return;
  }
  const rendered = `[${name}] ${util.format(message, ...args)}`;
  switch (level) {
    case 10 /* DEBUG */:
      console.debug(rendered);
      break;
    case 20 /* INFO */:
      console.info(rendered);
      break;
    case 30 /* WARN */:
      console.warn(rendered);
      break;
    case 40 /* ERROR */:
    case 50 /* CRITICAL */:
      console.error(rendered);
      break;
  }
}
function envLogLevel() {
  if (truthyEnv(process.env.DEBUG)) {
    return 10 /* DEBUG */;
  }
  const value = process.env.LOG_LEVEL?.toUpperCase();
  switch (value) {
    case "DEBUG":
      return 10 /* DEBUG */;
    case "WARNING":
    case "WARN":
      return 30 /* WARN */;
    case "ERROR":
      return 40 /* ERROR */;
    case "CRITICAL":
      return 50 /* CRITICAL */;
    case "INFO":
    case void 0:
      return 20 /* INFO */;
    default:
      return 20 /* INFO */;
  }
}
function truthyEnv(value) {
  return value !== void 0 && ["1", "true", "yes"].includes(value.toLowerCase());
}

// src/mcp/index.ts
var MCPError = class extends Error {
};
var MCPTimeoutError = class extends MCPError {
  constructor(message, timeout, config = null) {
    super(message);
    this.timeout = timeout;
    this.config = config;
  }
  timeout;
  config;
};
var MCPToolAction = class {
  data;
  constructor(data = {}) {
    this.data = { ...data };
  }
  toMcpArguments() {
    return { ...this.data };
  }
};
var MCPToolObservation = class _MCPToolObservation {
  content;
  is_error;
  tool_name;
  constructor(options) {
    this.content = [...options.content];
    this.is_error = options.is_error ?? false;
    this.tool_name = options.tool_name;
  }
  static fromText(text, options) {
    return new _MCPToolObservation({ content: [textContent(text)], is_error: options.is_error ?? false, tool_name: options.tool_name });
  }
  static fromCallToolResult(toolName, result) {
    const content = [textContent(`[Tool '${toolName}' executed.]`)];
    for (const block of result.content) {
      if (isMcpTextBlock(block)) {
        content.push(textContent(block.text));
      } else if (isMcpImageBlock(block)) {
        content.push(imageContent([`data:${block.mimeType};base64,${block.data}`]));
      }
    }
    return new _MCPToolObservation({ content, is_error: result.isError ?? false, tool_name: toolName });
  }
  visualize() {
    const lines = [`[MCP Tool '${this.tool_name}' Observation]`];
    for (const block of this.content) {
      if (block.type === "text") {
        lines.push(block.text);
      } else if (block.type === "image") {
        lines.push(`[Image with ${block.image_urls.length} URLs]`);
      }
    }
    return `${this.is_error ? "\u274C ERROR: " : ""}${lines.join("\n")}`;
  }
};
var MCPToolExecutor = class {
  constructor(toolName, client, timeoutSeconds = 300) {
    this.toolName = toolName;
    this.client = client;
    this.timeoutSeconds = timeoutSeconds;
  }
  toolName;
  client;
  timeoutSeconds;
  async execute(action) {
    if (!this.client.isConnected()) {
      return MCPToolObservation.fromText(`MCP client not connected for tool '${this.toolName}'. The connection may have been closed or failed to establish.`, { is_error: true, tool_name: this.toolName });
    }
    try {
      const result = await withTimeout(this.client.callTool(this.toolName, action.toMcpArguments()), this.timeoutSeconds);
      return MCPToolObservation.fromCallToolResult(this.toolName, result);
    } catch (error) {
      const message = error instanceof MCPTimeoutError ? `MCP tool '${this.toolName}' timed out after ${this.timeoutSeconds} seconds.` : `Error calling MCP tool ${this.toolName}: ${String(error)}`;
      return MCPToolObservation.fromText(message, { is_error: true, tool_name: this.toolName });
    }
  }
};
var MCPToolDefinition = class _MCPToolDefinition {
  name;
  description;
  inputSchema;
  annotations;
  meta;
  executor;
  constructor(spec, client) {
    this.name = spec.name;
    this.description = spec.description ?? "No description provided";
    this.inputSchema = spec.inputSchema ?? { type: "object", properties: {} };
    this.annotations = spec.annotations ?? null;
    this.meta = spec.meta ?? null;
    this.executor = new MCPToolExecutor(spec.name, client);
  }
  static create(spec, client) {
    return [new _MCPToolDefinition(spec, client)];
  }
  actionFromArguments(arguments_) {
    const sanitized = Object.fromEntries(Object.entries(arguments_).filter(([, value]) => value !== null && value !== void 0));
    return new MCPToolAction(sanitized);
  }
  toMcpTool(inputSchema, outputSchema) {
    if (inputSchema !== void 0 || outputSchema !== void 0) {
      throw new Error("MCPTool.toMcpTool does not support overriding schemas");
    }
    return { name: this.name, description: this.description, inputSchema: this.inputSchema };
  }
  toOpenAiTool() {
    return { type: "function", function: { name: this.name, description: this.description, parameters: this.inputSchema } };
  }
  toResponsesTool() {
    return { type: "function", name: this.name, description: this.description, parameters: this.inputSchema };
  }
};
function toCamelCase(value) {
  return value.split(/[_\-\s]+/u).filter((part) => part.length > 0).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}
function createMcpTools(config, clientFactory) {
  return clientFactory(config);
}
async function withTimeout(promise, timeoutSeconds) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new MCPTimeoutError(`MCP operation timed out after ${timeoutSeconds} seconds`, timeoutSeconds)), timeoutSeconds * 1e3);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
function isMcpTextBlock(block) {
  return block.type === "text" && typeof block.text === "string";
}
function isMcpImageBlock(block) {
  return block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string";
}
var AGENT_PROFILE_SCHEMA_VERSION = 1;
var acpServerKindSchema = zod.z.union([
  zod.z.literal("claude-code"),
  zod.z.literal("codex"),
  zod.z.literal("gemini-cli"),
  zod.z.literal("custom")
]);
var criticModeSchema = zod.z.union([zod.z.literal("finish_and_message"), zod.z.literal("all_actions")]);
var profileVerificationSettingsSchema = zod.z.object({
  critic_enabled: zod.z.boolean().default(false),
  critic_mode: criticModeSchema.default("finish_and_message"),
  enable_iterative_refinement: zod.z.boolean().default(false),
  critic_threshold: zod.z.number().min(0).max(1).default(0.6),
  max_refinement_iterations: zod.z.number().int().min(1).default(3),
  critic_server_url: zod.z.string().nullable().default(null),
  critic_model_name: zod.z.string().nullable().default(null)
});
var defaultProfileVerificationSettings = profileVerificationSettingsSchema.parse({});
var agentProfileBaseFields = {
  schema_version: zod.z.literal(AGENT_PROFILE_SCHEMA_VERSION).default(AGENT_PROFILE_SCHEMA_VERSION),
  id: zod.z.string().uuid().default(() => crypto.randomUUID()),
  name: zod.z.string().min(1),
  revision: zod.z.number().int().min(0).default(0),
  mcp_server_refs: zod.z.array(zod.z.string()).nullable().default(null)
};
var openHandsAgentProfileSchema = zod.z.object({
  ...agentProfileBaseFields,
  agent_kind: zod.z.literal("openhands").default("openhands"),
  llm_profile_ref: zod.z.string().min(1),
  agent: zod.z.string().default("CodeActAgent"),
  skills: zod.z.array(zod.z.unknown()).default([]),
  system_message_suffix: zod.z.string().nullable().default(null),
  condenser: zod.z.unknown().default({ condenser_kind: "llm_summarizing", enabled: true }),
  verification: profileVerificationSettingsSchema.default(defaultProfileVerificationSettings),
  enable_sub_agents: zod.z.boolean().default(false),
  tool_concurrency_limit: zod.z.number().int().min(1).default(1)
}).strict();
var acpAgentProfileSchema = zod.z.object({
  ...agentProfileBaseFields,
  agent_kind: zod.z.literal("acp").default("acp"),
  acp_server: acpServerKindSchema.default("claude-code"),
  acp_model: zod.z.string().nullable().default(null),
  acp_session_mode: zod.z.string().nullable().default(null),
  acp_prompt_timeout: zod.z.number().positive().default(1800),
  acp_command: zod.z.string().nullable().default(null),
  acp_args: zod.z.array(zod.z.string()).nullable().default(null)
}).strict();
var agentProfileSchema = zod.z.union([openHandsAgentProfileSchema, acpAgentProfileSchema]);
function validateAgentProfile(data) {
  const payload = applyAgentProfileMigrations(data);
  const kind = payload.agent_kind ?? "openhands";
  if (kind === "acp") {
    return acpAgentProfileSchema.parse(payload);
  }
  if (kind === "openhands") {
    return openHandsAgentProfileSchema.parse({ ...payload, agent_kind: "openhands" });
  }
  const renderedKind = typeof kind === "string" ? kind : JSON.stringify(kind);
  throw new Error(`Unknown agent_kind: ${renderedKind ?? "<unserializable>"}`);
}
function applyAgentProfileMigrations(data) {
  if (!isRecord6(data)) {
    throw new TypeError("AgentProfile payload must be a mapping.");
  }
  const migrated = { ...data };
  const version = migrated.schema_version;
  if (version === void 0 || version === null) {
    migrated.schema_version = AGENT_PROFILE_SCHEMA_VERSION;
    return migrated;
  }
  if (typeof version !== "number" || !Number.isInteger(version) || Object.is(version, -0)) {
    throw new TypeError(`AgentProfile schema_version must be an integer, got ${typeof version}.`);
  }
  if (version < 0) {
    throw new Error("AgentProfile schema_version must be non-negative.");
  }
  if (version > AGENT_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `AgentProfile schema_version ${version} is newer than supported version ${AGENT_PROFILE_SCHEMA_VERSION}.`
    );
  }
  return migrated;
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/observability/index.ts
var RootSpan = class {
  handle;
  ended = false;
  constructor(handle) {
    this.handle = handle;
  }
  end() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.handle.end?.();
  }
};
var observabilityEnvKeys = [
  "LMNR_PROJECT_API_KEY",
  "OTEL_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT"
];
var processObservabilityEnabled = false;
function getEnv(key, env = process.env) {
  const value = env[key];
  return value === "" ? void 0 : value;
}
function shouldEnableObservability(env = process.env) {
  if (env === process.env && processObservabilityEnabled) {
    return true;
  }
  const enabled = observabilityEnvKeys.some((key) => getEnv(key, env) !== void 0);
  if (enabled && env === process.env) {
    processObservabilityEnabled = true;
  }
  return enabled;
}
function maybeInitLaminar(options = {}) {
  if (!shouldEnableObservability(options.env ?? process.env)) {
    return false;
  }
  options.initializer?.();
  return true;
}
function observe(options = {}) {
  return (fn) => {
    if (!shouldEnableObservability(options.env ?? process.env) || options.adapter === void 0) {
      return fn;
    }
    return options.adapter.observe(options, fn);
  };
}
function startRootSpan(name, options = {}) {
  if (!shouldEnableObservability(options.env ?? process.env) || options.spanFactory === void 0) {
    return null;
  }
  try {
    const span = options.spanFactory(name, options);
    if (options.attributes !== void 0 && options.attributes !== null) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute?.(key, value);
      }
    }
    return new RootSpan(span);
  } catch {
    return null;
  }
}
function endRootSpan(root) {
  root?.end();
}
function extractActionName(actionEvent) {
  try {
    if (!isRecord7(actionEvent)) {
      return "agent.execute_action";
    }
    const action = actionEvent.action;
    if (isRecord7(action) && typeof action.kind === "string") {
      return action.kind;
    }
    if (typeof actionEvent.tool_name === "string") {
      return actionEvent.tool_name;
    }
    if (typeof actionEvent.toolName === "string") {
      return actionEvent.toolName;
    }
  } catch {
    return "agent.execute_action";
  }
  return "agent.execute_action";
}
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED = [
  "provider",
  "model",
  "openaiApiMode",
  "baseUrl",
  "apiVersion",
  "timeout",
  "temperature",
  "topP",
  "topK",
  "maxInputTokens",
  "maxOutputTokens",
  "reasoningEffort",
  "reasoningSummary",
  "promptCacheRetention",
  "promptCacheKey",
  "inputCostPerToken",
  "outputCostPerToken"
];
var AGENT_SETTINGS_SCHEMA_VERSION = 4;
var CONVERSATION_SETTINGS_SCHEMA_VERSION = 1;
var settingsSchemaVersion = (version) => zod.z.literal(version).default(version);
var observabilityMetadataSchema = zod.z.record(zod.z.string().min(1), zod.z.unknown());
var observabilityTagsSchema = zod.z.array(zod.z.string());
var conversationSettingsSchema = zod.z.object({
  schema_version: settingsSchemaVersion(CONVERSATION_SETTINGS_SCHEMA_VERSION),
  max_iterations: zod.z.number().int().min(1).default(500),
  observability_metadata: observabilityMetadataSchema.nullable().default(null),
  observability_tags: observabilityTagsSchema.nullable().default(null)
}).strict();
var agentSettingsBaseFields = {
  schema_version: settingsSchemaVersion(AGENT_SETTINGS_SCHEMA_VERSION),
  mcp_config: zod.z.unknown().nullable().default(null)
};
var defaultVerificationSettings = profileVerificationSettingsSchema.parse({});
var openHandsAgentSettingsSchema = zod.z.object({
  ...agentSettingsBaseFields,
  agent_kind: zod.z.literal("openhands").default("openhands"),
  llm_profile_ref: zod.z.string().min(1),
  agent: zod.z.string().default("CodeActAgent"),
  tools: zod.z.array(zod.z.unknown()).default([]),
  enable_sub_agents: zod.z.boolean().default(false),
  enable_switch_llm_tool: zod.z.boolean().default(true),
  tool_concurrency_limit: zod.z.number().int().min(1).default(1),
  condenser: zod.z.unknown().default({ condenser_kind: "llm_summarizing", enabled: true }),
  verification: profileVerificationSettingsSchema.default(defaultVerificationSettings)
}).strict();
var acpAgentSettingsSchema = zod.z.object({
  ...agentSettingsBaseFields,
  agent_kind: zod.z.literal("acp").default("acp"),
  acp_server: acpServerKindSchema.default("claude-code"),
  acp_command: zod.z.array(zod.z.string()).default([]),
  acp_args: zod.z.array(zod.z.string()).default([]),
  acp_model: zod.z.string().nullable().default(null),
  acp_session_mode: zod.z.string().nullable().default(null),
  acp_prompt_timeout: zod.z.number().positive().default(1800)
}).strict();
var agentSettingsSchema = zod.z.union([openHandsAgentSettingsSchema, acpAgentSettingsSchema]);
function clearRawLlmFieldsWhenProfileSelected(llm) {
  const profileId = typeof llm.profileId === "string" ? llm.profileId.trim() : "";
  if (profileId.length === 0) {
    return llm;
  }
  return {
    ...llm,
    provider: void 0,
    model: void 0,
    openaiApiMode: void 0,
    baseUrl: void 0,
    apiVersion: void 0,
    timeout: void 0,
    temperature: void 0,
    topP: void 0,
    topK: void 0,
    maxInputTokens: void 0,
    maxOutputTokens: void 0,
    reasoningEffort: void 0,
    reasoningSummary: void 0,
    promptCacheRetention: void 0,
    promptCacheKey: void 0,
    inputCostPerToken: void 0,
    outputCostPerToken: void 0
  };
}
function validateAgentSettings(data) {
  const payload = applySettingsVersion(data, AGENT_SETTINGS_SCHEMA_VERSION, "AgentSettings");
  const kind = payload.agent_kind ?? "openhands";
  if (kind === "acp") {
    return acpAgentSettingsSchema.parse(payload);
  }
  if (kind === "llm" || kind === "openhands") {
    return openHandsAgentSettingsSchema.parse({ ...payload, agent_kind: "openhands" });
  }
  const renderedKind = typeof kind === "string" ? kind : JSON.stringify(kind);
  throw new Error(`Unknown agent_kind: ${renderedKind ?? "<unserializable>"}`);
}
function validateConversationSettings(data) {
  return conversationSettingsSchema.parse(
    applySettingsVersion(data, CONVERSATION_SETTINGS_SCHEMA_VERSION, "ConversationSettings")
  );
}
function defaultAgentSettings(llmProfileRef) {
  return openHandsAgentSettingsSchema.parse({ llm_profile_ref: llmProfileRef });
}
function applySettingsVersion(data, currentVersion, payloadName) {
  if (!isRecord8(data)) {
    throw new TypeError(`${payloadName} payload must be a mapping.`);
  }
  const migrated = { ...data };
  const version = migrated.schema_version;
  if (version === void 0 || version === null) {
    migrated.schema_version = currentVersion;
    return migrated;
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new TypeError(`${payloadName} schema_version must be an integer, got ${typeof version}.`);
  }
  if (version < 0) {
    throw new Error(`${payloadName} schema_version must be non-negative.`);
  }
  if (version > currentVersion) {
    throw new Error(`${payloadName} schema_version ${version} is newer than supported version ${currentVersion}.`);
  }
  migrated.schema_version = currentVersion;
  return migrated;
}
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var knownAgentFields = /* @__PURE__ */ new Set([
  "name",
  "description",
  "model",
  "color",
  "tools",
  "skills",
  "max_iteration_per_run",
  "max_budget_per_run",
  "hooks",
  "profile_store_dir",
  "mcp_servers",
  "permission_mode",
  "condenser"
]);
var agentDirectories = [".agents/agents", ".openhands/agents"];
var skipFiles = /* @__PURE__ */ new Set(["README.md", "readme.md"]);
var AgentDefinition = class _AgentDefinition {
  name;
  description;
  model;
  color;
  tools;
  skills;
  system_prompt;
  source;
  when_to_use_examples;
  hooks;
  max_iteration_per_run;
  max_budget_per_run;
  mcp_servers;
  profile_store_dir;
  condenser;
  metadata;
  constructor(options) {
    this.name = options.name;
    this.description = options.description ?? "";
    this.model = options.model ?? "inherit";
    this.color = options.color ?? null;
    this.tools = [...options.tools ?? []];
    this.skills = [...options.skills ?? []];
    this.system_prompt = options.system_prompt ?? "";
    this.source = options.source ?? null;
    this.when_to_use_examples = [...options.when_to_use_examples ?? []];
    this.hooks = options.hooks ?? null;
    this.max_iteration_per_run = positiveNumberOrNull(options.max_iteration_per_run ?? null, "max_iteration_per_run");
    this.max_budget_per_run = positiveNumberOrNull(options.max_budget_per_run ?? null, "max_budget_per_run");
    this.mcp_servers = options.mcp_servers ?? null;
    this.profile_store_dir = options.profile_store_dir ?? null;
    this.condenser = options.condenser ?? null;
    this.metadata = { ...options.metadata ?? {} };
  }
  static async load(agentPath) {
    const fileContent = await promises.readFile(agentPath, "utf8");
    const parsed = parseFrontmatter2(fileContent);
    const metadata = parsed.metadata;
    const name = stringField(metadata.name, path2.basename(agentPath, path2.extname(agentPath)));
    const description = stringField(metadata.description, "");
    return new _AgentDefinition({
      name,
      description,
      model: stringField(metadata.model, "inherit"),
      color: nullableString(metadata.color),
      tools: stringList2(metadata.tools, false),
      skills: stringList2(metadata.skills, true),
      max_iteration_per_run: optionalNumber(metadata.max_iteration_per_run),
      max_budget_per_run: optionalNumber(metadata.max_budget_per_run),
      mcp_servers: recordOrNull(metadata.mcp_servers, "mcp_servers"),
      profile_store_dir: nullableString(metadata.profile_store_dir),
      hooks: metadata.hooks,
      condenser: metadata.condenser,
      system_prompt: parsed.content.trim(),
      source: toPosixPath3(agentPath),
      when_to_use_examples: examplesFrom(description),
      metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownAgentFields.has(key)))
    });
  }
};
async function loadProjectAgents(projectDir) {
  return loadAgentsFromDirs(agentDirectories.map((dir) => path2.join(projectDir, dir)));
}
async function loadUserAgents() {
  return loadAgentsFromDirs(agentDirectories.map((dir) => path2.join(os.homedir(), dir)));
}
async function loadAgentsFromDirs(directories) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const directory of directories) {
    for (const definition of await loadAgentsFromDir(directory)) {
      if (!seen.has(definition.name)) {
        seen.add(definition.name);
        result.push(definition);
      }
    }
  }
  return result;
}
async function loadAgentsFromDir(agentsDir) {
  if (!await isDirectory(agentsDir)) {
    return [];
  }
  const definitions = [];
  for (const entry of (await promises.readdir(agentsDir)).sort()) {
    const path3 = path2.join(agentsDir, entry);
    if (skipFiles.has(entry) || path2.extname(entry).toLowerCase() !== ".md" || await isDirectory(path3)) {
      continue;
    }
    try {
      definitions.push(await AgentDefinition.load(path3));
    } catch {
    }
  }
  return definitions;
}
var agentFactories = /* @__PURE__ */ new Map();
function registerAgent(name, factoryFunc, description) {
  if (agentFactories.has(name)) {
    throw new Error(`Agent '${name}' already registered`);
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
}
function registerAgentIfAbsent(name, factoryFunc, description) {
  if (agentFactories.has(name)) {
    return false;
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
  return true;
}
function getAgentFactory(name) {
  const deprecated = { default: "general-purpose", "default cli mode": "general-purpose", explore: "code-explorer", bash: "bash-runner" };
  const factoryName = name === null || name === void 0 || name.length === 0 ? "general-purpose" : deprecated[name] ?? name;
  const factory = agentFactories.get(factoryName);
  if (factory === void 0) {
    const available = [...agentFactories.keys()].sort().join(", ") || "none registered";
    throw new Error(`Unknown agent '${name ?? ""}'. Available types: ${available}. Use registerAgent() to add custom agent types.`);
  }
  return factory;
}
function getFactoryInfo() {
  if (agentFactories.size === 0) {
    return "- No user-registered agents yet. Call registerAgent(...) to add custom agents.";
  }
  return [...agentFactories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, factory]) => {
    const tools = factory.definition.tools.length > 0 ? ` (tools: ${factory.definition.tools.join(", ")})` : "";
    return `- **${name}**: ${factory.definition.description}${tools}`;
  }).join("\n");
}
function getRegisteredAgentDefinitions() {
  return [...agentFactories.values()].map((factory) => factory.definition);
}
function resetAgentRegistryForTests() {
  agentFactories.clear();
}
function resolveAgentDefinition(name, description) {
  return description instanceof AgentDefinition ? description : new AgentDefinition({ name, description });
}
function parseFrontmatter2(fileContent) {
  if (!fileContent.startsWith("---")) {
    return { metadata: {}, content: fileContent };
  }
  const end = fileContent.indexOf("\n---", 3);
  if (end === -1) {
    return { metadata: {}, content: fileContent };
  }
  return { metadata: parseSimpleYaml(fileContent.slice(3, end)), content: fileContent.slice(end + 4).replace(/^\r?\n/, "") };
}
function parseSimpleYaml(frontmatter) {
  const metadata = {};
  for (const line of frontmatter.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    metadata[trimmed.slice(0, separator).trim()] = parseScalar(trimmed.slice(separator + 1).trim());
  }
  return metadata;
}
function parseScalar(value) {
  const unquoted = stripQuotes2(value);
  if (unquoted === "true") {
    return true;
  }
  if (unquoted === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(unquoted)) {
    return Number(unquoted);
  }
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    return unquoted.slice(1, -1).split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  }
  return unquoted;
}
function stripQuotes2(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}
function stringField(value, fallback) {
  return value === void 0 || value === null ? fallback : scalarToString(value);
}
function nullableString(value) {
  return value === void 0 || value === null ? null : scalarToString(value);
}
function scalarToString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  throw new Error("Expected a scalar string-compatible value");
}
function stringList2(value, splitComma) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return splitComma ? value.split(",").map((part) => part.trim()).filter((part) => part.length > 0) : [value];
  }
  return [];
}
function optionalNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }
  return null;
}
function positiveNumberOrNull(value, field) {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return value;
}
function recordOrNull(value, field) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  throw new Error(`${field} must be a mapping`);
}
function examplesFrom(description) {
  return [...description.matchAll(/<example>(.*?)<\/example>/gis)].map((match) => match[1]?.trim() ?? "").filter((example) => example.length > 0);
}
function toPosixPath3(path3) {
  return path3.split(path2.sep).join(path2.posix.sep);
}
async function isDirectory(path3) {
  try {
    return (await promises.stat(path3)).isDirectory();
  } catch {
    return false;
  }
}

// src/testing/index.ts
var TestLLMExhaustedError = class extends Error {
  constructor(callCount) {
    super(`TestLLM: no more scripted responses (exhausted after ${callCount} calls)`);
    this.name = "TestLLMExhaustedError";
  }
};
var TestLLM = class _TestLLM {
  profile;
  responses;
  defaultUsage;
  calls = 0;
  constructor(options = {}) {
    this.profile = options.profile ?? defaultTestProfile();
    this.responses = [...options.scriptedResponses ?? []];
    this.defaultUsage = options.defaultUsage === void 0 ? llmUsageSchema.parse({}) : options.defaultUsage;
  }
  static fromMessages(messages, options = {}) {
    return new _TestLLM({ ...options, scriptedResponses: messages });
  }
  static fromResponses(responses, options = {}) {
    return new _TestLLM({ ...options, scriptedResponses: responses });
  }
  get callCount() {
    return this.calls;
  }
  get remainingResponses() {
    return this.responses.length;
  }
  complete(_messages) {
    try {
      return Promise.resolve(this.nextResponse());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  nextResponse() {
    if (this.responses.length === 0) {
      throw new TestLLMExhaustedError(this.calls);
    }
    const item = this.responses.shift();
    this.calls += 1;
    if (item instanceof Error) {
      throw item;
    }
    if (isCompletionResponse(item)) {
      return llmCompletionResponseSchema.parse(item);
    }
    const message = messageSchema.parse(item);
    return llmCompletionResponseSchema.parse({
      message,
      usage: this.defaultUsage,
      raw: {
        id: `test-response-${this.calls}`,
        model: this.profile.model
      }
    });
  }
};
function defaultTestProfile() {
  return llmProfileSchema.parse({
    profileId: "test-llm",
    providerId: "test",
    model: "test-model"
  });
}
function isCompletionResponse(value) {
  return typeof value === "object" && value !== null && "message" in value;
}
var toolAnnotationsSchema = zod.z.object({
  title: zod.z.string().nullable().default(null),
  readOnlyHint: zod.z.boolean().default(false),
  destructiveHint: zod.z.boolean().default(true),
  idempotentHint: zod.z.boolean().default(false),
  openWorldHint: zod.z.boolean().default(true)
}).strict();
var toolSpecSchema = zod.z.object({
  name: zod.z.string().min(1),
  params: zod.z.record(zod.z.string(), zod.z.unknown()).default({})
}).strict();
var ToolDefinition = class {
  name;
  description;
  inputSchema;
  outputSchema;
  executor;
  annotations;
  meta;
  usable;
  constructor(options) {
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.executor = options.executor;
    this.annotations = options.annotations;
    this.meta = options.meta;
    this.usable = options.usable ?? true;
  }
  async execute(input, context) {
    if (this.executor === void 0) {
      throw new Error(`Tool '${this.name}' has no executor`);
    }
    const action = this.inputSchema.parse(input);
    const result = await this.executor(action, context);
    if (this.outputSchema === void 0) {
      return result;
    }
    return this.outputSchema.parse(result);
  }
  toMcpTool(inputSchema, outputSchema) {
    const tool = {
      name: this.name,
      description: this.description,
      inputSchema: inputSchema ?? schemaToJsonObject(this.inputSchema)
    };
    const derivedOutputSchema = outputSchema ?? (this.outputSchema === void 0 ? void 0 : schemaToJsonObject(this.outputSchema));
    if (derivedOutputSchema !== void 0) {
      tool.outputSchema = derivedOutputSchema;
    }
    if (this.annotations !== void 0) {
      tool.annotations = this.annotations;
    }
    if (this.meta !== void 0) {
      tool._meta = this.meta;
    }
    return tool;
  }
  toResponsesTool() {
    return {
      type: "function",
      name: this.name,
      description: this.description,
      strict: false,
      parameters: schemaToJsonObject(this.inputSchema)
    };
  }
};
var ToolRegistry = class {
  registrations = /* @__PURE__ */ new Map();
  register(name, tool) {
    this.registrations.set(name, tool);
  }
  registerFactory(name, factory) {
    this.registrations.set(name, factory);
  }
  resolve(spec, context) {
    const parsedSpec = toolSpecSchema.parse(spec);
    const registration = this.registrations.get(parsedSpec.name);
    if (registration === void 0) {
      throw new Error(`Unknown tool: ${parsedSpec.name}`);
    }
    if (registration instanceof ToolDefinition) {
      if (Object.keys(parsedSpec.params).length > 0) {
        throw new Error(`Registered tool instance '${parsedSpec.name}' does not accept params`);
      }
      return [registration];
    }
    return registration(parsedSpec.params, context);
  }
  listRegisteredTools() {
    return [...this.registrations.keys()];
  }
  listUsableTools() {
    return [...this.registrations.entries()].filter(([_name, registration]) => !(registration instanceof ToolDefinition) || registration.usable).map(([name]) => name);
  }
};
var globalToolRegistry = new ToolRegistry();
function registerTool(name, tool) {
  globalToolRegistry.register(name, tool);
}
function registerToolFactory(name, factory) {
  globalToolRegistry.registerFactory(name, factory);
}
function resolveTool(spec, context) {
  return globalToolRegistry.resolve(spec, context);
}
function listRegisteredTools() {
  return globalToolRegistry.listRegisteredTools();
}
function listUsableTools() {
  return globalToolRegistry.listUsableTools();
}
function schemaToJsonObject(schema) {
  const jsonSchema = zod.z.toJSONSchema(schema);
  if (!isJsonObject(jsonSchema)) {
    throw new Error("Zod schema did not produce a JSON object schema");
  }
  return jsonSchema;
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var baseObservationSchema = zod.z.object({
  text: zod.z.string(),
  is_error: zod.z.boolean().default(false)
}).strict();
var finishActionSchema = zod.z.object({
  message: zod.z.string().describe("Final message to send to the user.")
}).strict();
var thinkActionSchema = zod.z.object({
  thought: zod.z.string().describe("The thought to log.")
}).strict();
var safeBuiltinAnnotations = toolAnnotationsSchema.parse({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});
var FINISH_DESCRIPTION = `Signals the completion of the current task or conversation.

Use this tool when:
- You have successfully completed the user's requested task
- You cannot proceed further due to technical limitations or missing information

The message should include:
- A clear summary of actions taken and their results
- Any next steps for the user
- Explanation if you're unable to complete the task
- Any follow-up questions if more information is needed
`;
var FinishTool = class {
  static className = "FinishTool";
  static create() {
    return new ToolDefinition({
      name: "finish",
      description: FINISH_DESCRIPTION,
      inputSchema: finishActionSchema,
      outputSchema: baseObservationSchema,
      annotations: toolAnnotationsSchema.parse({ ...safeBuiltinAnnotations, title: "finish" }),
      executor: (action) => ({ text: action.message, is_error: false })
    });
  }
};
var THINK_DESCRIPTION = `Use the tool to think about something. It will not obtain new information or make any changes to the repository, but just log the thought. Use it when complex reasoning or brainstorming is needed.

Common use cases:
1. When exploring a repository and discovering the source of a bug, call this tool to brainstorm several unique ways of fixing the bug, and assess which change(s) are likely to be simplest and most effective.
2. After receiving test results, use this tool to brainstorm ways to fix failing tests.
3. When planning a complex refactoring, use this tool to outline different approaches and their tradeoffs.
4. When designing a new feature, use this tool to think through architecture decisions and implementation details.
5. When debugging a complex issue, use this tool to organize your thoughts and hypotheses.

The tool simply logs your thought process for better transparency and does not execute any code or make changes.`;
var ThinkTool = class {
  static className = "ThinkTool";
  static create() {
    return new ToolDefinition({
      name: "think",
      description: THINK_DESCRIPTION,
      inputSchema: thinkActionSchema,
      outputSchema: baseObservationSchema,
      annotations: safeBuiltinAnnotations,
      executor: () => ({ text: "Your thought has been logged.", is_error: false })
    });
  }
};
var BUILT_IN_TOOLS = [() => FinishTool.create(), () => ThinkTool.create()];
var BUILT_IN_TOOL_FACTORIES = {
  FinishTool: () => FinishTool.create(),
  ThinkTool: () => ThinkTool.create()
};
var execAsync = util.promisify(child_process.exec);
var baseToolObservationSchema = zod.z.object({ text: zod.z.string(), is_error: zod.z.boolean().default(false) }).strict();
var terminalActionSchema = zod.z.object({ command: zod.z.string(), is_input: zod.z.boolean().default(false), timeout: zod.z.number().nonnegative().nullable().default(null), reset: zod.z.boolean().default(false) }).strict();
var terminalObservationSchema = baseToolObservationSchema.extend({ command: zod.z.string().nullable().default(null), exit_code: zod.z.number().nullable().default(null), timeout: zod.z.boolean().default(false) }).strict();
var TerminalExecutor = class {
  workingDir;
  constructor(options) {
    this.workingDir = options.workingDir;
  }
  async execute(action) {
    const parsed = terminalActionSchema.parse(action);
    if (parsed.is_input) return { text: "Interactive input is not supported by this executor.", is_error: true, command: parsed.command, exit_code: null, timeout: false };
    try {
      const { stdout, stderr } = await execAsync(parsed.command, { cwd: this.workingDir, timeout: parsed.timeout === null ? void 0 : parsed.timeout * 1e3 });
      return { text: `${stdout}${stderr}`, is_error: false, command: parsed.command, exit_code: 0, timeout: false };
    } catch (error) {
      const err = error;
      return { text: `${err.stdout ?? ""}${err.stderr ?? String(error)}`, is_error: true, command: parsed.command, exit_code: typeof err.code === "number" ? err.code : -1, timeout: err.killed ?? false };
    }
  }
};
var TerminalTool = class {
  static create(options) {
    const executor = new TerminalExecutor(options);
    return new ToolDefinition({ name: "terminal", description: "Execute a shell command in the project workspace.", inputSchema: terminalActionSchema, outputSchema: terminalObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "terminal", openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
};
var fileEditorActionSchema = zod.z.object({ command: zod.z.enum(["view", "create", "str_replace", "insert", "undo_edit"]), path: zod.z.string(), file_text: zod.z.string().nullable().default(null), old_str: zod.z.string().nullable().default(null), new_str: zod.z.string().nullable().default(null), insert_line: zod.z.number().int().nonnegative().nullable().default(null), view_range: zod.z.array(zod.z.number().int()).nullable().default(null) }).strict();
var fileEditorObservationSchema = baseToolObservationSchema.extend({ command: zod.z.enum(["view", "create", "str_replace", "insert", "undo_edit"]), path: zod.z.string().nullable().default(null), prev_exist: zod.z.boolean().default(true), old_content: zod.z.string().nullable().default(null), new_content: zod.z.string().nullable().default(null) }).strict();
var FileEditorExecutor = class {
  history = /* @__PURE__ */ new Map();
  workspaceRoot;
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot ? path2.resolve(options.workspaceRoot) : null;
  }
  async execute(action) {
    const parsed = fileEditorActionSchema.parse(action);
    const path3 = this.resolvePath(parsed.path);
    try {
      if (parsed.command === "view") return await this.view(path3, parsed);
      if (parsed.command === "create") return await this.create(path3, parsed);
      if (parsed.command === "str_replace") return await this.strReplace(path3, parsed);
      if (parsed.command === "insert") return await this.insert(path3, parsed);
      return await this.undo(path3, parsed);
    } catch (error) {
      return this.observation({ text: error instanceof Error ? error.message : String(error), is_error: true, command: parsed.command, path: path3 });
    }
  }
  resolvePath(path3) {
    const resolved = path2.resolve(path3);
    if (this.workspaceRoot !== null && !(resolved === this.workspaceRoot || resolved.startsWith(`${this.workspaceRoot}${path2.sep}`))) throw new Error(`Path escapes workspace: ${path3}`);
    return resolved;
  }
  async view(path3, action) {
    const info = await promises.stat(path3);
    if (info.isDirectory()) return this.observation({ text: (await listDirectory(path3)).join("\n"), is_error: false, command: action.command, path: path3 });
    const numbered = numberLines(await promises.readFile(path3, "utf8"), action.view_range);
    return this.observation({ text: numbered, is_error: false, command: action.command, path: path3 });
  }
  async create(path3, action) {
    if (action.file_text === null) throw new Error("file_text is required for create");
    if (await exists3(path3)) throw new Error(`File already exists: ${path3}`);
    await promises.mkdir(path2.dirname(path3), { recursive: true });
    await promises.writeFile(path3, action.file_text);
    return this.observation({ text: `File created: ${path3}`, is_error: false, command: action.command, path: path3, prev_exist: false, new_content: action.file_text });
  }
  async strReplace(path3, action) {
    if (action.old_str === null) throw new Error("old_str is required for str_replace");
    const oldContent = await promises.readFile(path3, "utf8");
    const count = oldContent.split(action.old_str).length - 1;
    if (count === 0) throw new Error("old_str was not found in the file");
    if (count > 1) throw new Error("old_str appears multiple times; provide a unique match");
    this.pushHistory(path3, oldContent);
    const newContent = oldContent.replace(action.old_str, action.new_str ?? "");
    await promises.writeFile(path3, newContent);
    return this.observation({ text: `Edited ${path3}`, is_error: false, command: action.command, path: path3, old_content: oldContent, new_content: newContent });
  }
  async insert(path3, action) {
    if (action.insert_line === null || action.new_str === null) throw new Error("insert_line and new_str are required for insert");
    const oldContent = await promises.readFile(path3, "utf8");
    this.pushHistory(path3, oldContent);
    const lines = oldContent.split("\n");
    lines.splice(action.insert_line, 0, action.new_str);
    const newContent = normalizeTrailingNewline(lines.join("\n"), oldContent);
    await promises.writeFile(path3, newContent);
    return this.observation({ text: `Inserted text into ${path3}`, is_error: false, command: action.command, path: path3, old_content: oldContent, new_content: newContent });
  }
  async undo(path3, action) {
    const stack = this.history.get(path3) ?? [];
    const previous = stack.pop();
    if (previous === void 0) throw new Error(`No edit history for ${path3}`);
    const oldContent = await promises.readFile(path3, "utf8").catch(() => "");
    await promises.writeFile(path3, previous);
    return this.observation({ text: `Undid last edit for ${path3}`, is_error: false, command: action.command, path: path3, old_content: oldContent, new_content: previous });
  }
  observation(partial) {
    return fileEditorObservationSchema.parse({ path: null, prev_exist: true, old_content: null, new_content: null, ...partial });
  }
  pushHistory(path3, content) {
    this.history.set(path3, [...this.history.get(path3) ?? [], content]);
  }
};
var FileEditorTool = class {
  static create(options = {}) {
    const executor = new FileEditorExecutor(options);
    return new ToolDefinition({ name: "file_editor", description: "View and edit text files with create, replace, insert, and undo operations.", inputSchema: fileEditorActionSchema, outputSchema: fileEditorObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "file_editor", destructiveHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
};
var globActionSchema = zod.z.object({ pattern: zod.z.string(), path: zod.z.string().nullable().default(null) }).strict();
var globObservationSchema = baseToolObservationSchema.extend({ files: zod.z.array(zod.z.string()).default([]), pattern: zod.z.string(), search_path: zod.z.string(), truncated: zod.z.boolean().default(false) }).strict();
var GlobExecutor = class {
  workingDir;
  constructor(options) {
    this.workingDir = path2.resolve(options.workingDir);
  }
  async execute(action) {
    const parsed = globActionSchema.parse(action);
    const searchPath = path2.resolve(parsed.path ?? this.workingDir);
    const files = (await walkFiles(searchPath)).filter((file) => globMatch(parsed.pattern, file.slice(searchPath.length + 1))).slice(0, 100);
    const text = files.length === 0 ? `No files found matching pattern '${parsed.pattern}' in directory '${searchPath}'` : `Found ${files.length} file(s) matching pattern '${parsed.pattern}' in '${searchPath}':
${files.join("\n")}`;
    return { text, is_error: false, files, pattern: parsed.pattern, search_path: searchPath, truncated: files.length >= 100 };
  }
};
var GlobTool = class {
  static create(options) {
    const executor = new GlobExecutor(options);
    return new ToolDefinition({ name: "glob", description: "Find files by glob pattern recursively.", inputSchema: globActionSchema, outputSchema: globObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "glob", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
};
var grepActionSchema = zod.z.object({ pattern: zod.z.string(), path: zod.z.string().nullable().default(null), include: zod.z.string().nullable().default(null), max_results: zod.z.number().int().positive().default(100) }).strict();
var grepMatchSchema = zod.z.object({ file: zod.z.string(), line: zod.z.number(), text: zod.z.string() }).strict();
var grepObservationSchema = baseToolObservationSchema.extend({ matches: zod.z.array(grepMatchSchema), pattern: zod.z.string(), search_path: zod.z.string(), truncated: zod.z.boolean().default(false) }).strict();
var GrepExecutor = class {
  workingDir;
  constructor(options) {
    this.workingDir = path2.resolve(options.workingDir);
  }
  async execute(action) {
    const parsed = grepActionSchema.parse(action);
    const searchPath = path2.resolve(parsed.path ?? this.workingDir);
    const regex = new RegExp(parsed.pattern, "u");
    const matches = [];
    for (const file of await walkFiles(searchPath)) {
      const rel = file.slice(searchPath.length + 1);
      if (parsed.include !== null && !globMatch(parsed.include, rel)) continue;
      const text = await promises.readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      text.split(/\r?\n/u).forEach((lineText, index) => {
        if (matches.length < parsed.max_results && regex.test(lineText)) matches.push({ file, line: index + 1, text: lineText });
      });
    }
    return { text: matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n") || `No matches for '${parsed.pattern}'`, is_error: false, matches, pattern: parsed.pattern, search_path: searchPath, truncated: matches.length >= parsed.max_results };
  }
};
var GrepTool = class {
  static create(options) {
    const executor = new GrepExecutor(options);
    return new ToolDefinition({ name: "grep", description: "Search file contents recursively.", inputSchema: grepActionSchema, outputSchema: grepObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "grep", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
};
var taskItemSchema = zod.z.object({ title: zod.z.string(), notes: zod.z.string().default(""), status: zod.z.enum(["todo", "in_progress", "done"]).default("todo") }).strict();
var taskTrackerActionSchema = zod.z.object({ command: zod.z.enum(["view", "plan"]).default("view"), task_list: zod.z.array(taskItemSchema).default([]) }).strict();
var taskTrackerObservationSchema = baseToolObservationSchema.extend({ command: zod.z.enum(["view", "plan"]), task_list: zod.z.array(taskItemSchema).default([]) }).strict();
var TaskTrackerExecutor = class {
  taskList = [];
  saveDir;
  constructor(options = {}) {
    this.saveDir = options.saveDir ?? null;
  }
  async execute(action) {
    const parsed = taskTrackerActionSchema.parse(action);
    if (parsed.command === "plan") {
      this.taskList = parsed.task_list;
      if (this.saveDir !== null) await this.saveTasks();
      return { text: `Task list has been updated with ${this.taskList.length} item(s).`, is_error: false, command: "plan", task_list: this.taskList };
    }
    return { text: this.taskList.length === 0 ? 'No task list found. Use the "plan" command to create one.' : formatTasks(this.taskList), is_error: false, command: "view", task_list: this.taskList };
  }
  async saveTasks() {
    if (this.saveDir === null) return;
    await promises.mkdir(this.saveDir, { recursive: true });
    await promises.writeFile(path2.join(this.saveDir, "TASKS.md"), formatTasks(this.taskList));
  }
};
var TaskTrackerTool = class {
  static create(options = {}) {
    const executor = new TaskTrackerExecutor(options);
    return new ToolDefinition({ name: "task_tracker", description: "View or update a structured task list.", inputSchema: taskTrackerActionSchema, outputSchema: taskTrackerObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "task_tracker", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
};
var browserActionSchema = zod.z.object({ command: zod.z.enum(["navigate", "get_state", "click", "type", "scroll", "back"]), url: zod.z.string().nullable().default(null), index: zod.z.number().int().nullable().default(null), text: zod.z.string().nullable().default(null), direction: zod.z.enum(["up", "down"]).default("down") }).strict();
var browserObservationSchema = baseToolObservationSchema;
var BrowserTool = class {
  static create(options) {
    return new ToolDefinition({ name: "browser", description: "Interact with a browser through an injected adapter.", inputSchema: browserActionSchema, outputSchema: browserObservationSchema, annotations: toolAnnotationsSchema.parse({ title: "browser", destructiveHint: false, openWorldHint: true }), executor: async (action) => executeBrowserAction(options.adapter, action) });
  }
};
async function executeBrowserAction(adapter, action) {
  if (action.command === "navigate" && action.url !== null && adapter.navigate) return adapter.navigate(action.url);
  if (action.command === "get_state" && adapter.getState) return adapter.getState();
  if (action.command === "click" && action.index !== null && adapter.click) return adapter.click(action.index);
  if (action.command === "type" && action.index !== null && action.text !== null && adapter.type) return adapter.type(action.index, action.text);
  if (action.command === "scroll" && adapter.scroll) return adapter.scroll(action.direction);
  if (action.command === "back" && adapter.back) return adapter.back();
  return { text: `Browser adapter does not support command '${action.command}' or required arguments are missing.`, is_error: true };
}
async function exists3(path3) {
  return promises.stat(path3).then(() => true).catch(() => false);
}
async function listDirectory(path3) {
  const entries = await promises.readdir(path3, { withFileTypes: true });
  return entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`).sort();
}
function numberLines(content, range) {
  const lines = content.replace(/\n$/u, "").split("\n");
  const start = range?.[0] ?? 1;
  const end = range?.[1] === -1 ? lines.length : range?.[1] ?? lines.length;
  return lines.slice(start - 1, end).map((line, index) => `${start + index}	${line}`).join("\n");
}
function normalizeTrailingNewline(content, oldContent) {
  return oldContent.endsWith("\n") && !content.endsWith("\n") ? `${content}
` : content;
}
async function walkFiles(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const path3 = path2.join(dir, entry.name);
      if (entry.isDirectory()) await walk(path3);
      else if (entry.isFile()) result.push(path3);
    }
  }
  await walk(root);
  return result.sort();
}
function globMatch(pattern, relativePath) {
  const normalized = relativePath.split(path2.sep).join(path2.posix.sep);
  const escaped = pattern.split(/[\\/]/u).map((part) => part.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*")).join("/");
  return new RegExp(`(^|/)${escaped}$`, "u").test(normalized);
}
function formatTasks(tasks) {
  return `# Task List

${tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.title}${task.notes ? `
   Notes: ${task.notes}` : ""}`).join("\n")}`;
}
var execAsync2 = util.promisify(child_process.exec);
var LocalWorkspace = class {
  workingDir;
  constructor(options = {}) {
    this.workingDir = path2.resolve(options.workingDir ?? options.working_dir ?? "workspace/project");
  }
  async executeCommand(command, options = {}) {
    const cwd = options.cwd === void 0 || options.cwd === null ? this.workingDir : this.resolvePath(options.cwd);
    const timeout = (options.timeoutSeconds ?? 30) * 1e3;
    try {
      const { stdout, stderr } = await execAsync2(command, { cwd, timeout });
      return { command, exitCode: 0, stdout, stderr, timeoutOccurred: false };
    } catch (error) {
      if (isExecError3(error)) {
        return {
          command,
          exitCode: typeof error.code === "number" ? error.code : -1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          timeoutOccurred: error.killed === true || error.signal === "SIGTERM"
        };
      }
      throw error;
    }
  }
  async fileUpload(sourcePath, destinationPath) {
    return this.copy(sourcePath, destinationPath);
  }
  async fileDownload(sourcePath, destinationPath) {
    return this.copy(sourcePath, destinationPath);
  }
  async gitChanges(path3) {
    return getChangesInRepo(this.resolvePath(path3), "HEAD");
  }
  async gitDiff(path3) {
    return getGitDiff(this.resolvePath(path3), "HEAD");
  }
  async pause() {
    return Promise.resolve();
  }
  async resume() {
    return Promise.resolve();
  }
  async copy(sourcePath, destinationPath) {
    const source = this.resolvePath(sourcePath);
    const destination = this.resolvePath(destinationPath);
    try {
      await promises.mkdir(path2.dirname(destination), { recursive: true });
      await promises.copyFile(source, destination);
      const info = await promises.stat(destination);
      return { success: true, sourcePath: source, destinationPath: destination, fileSize: info.size };
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }
  resolvePath(path3) {
    return path2.isAbsolute(path3) ? path2.resolve(path3) : path2.resolve(this.workingDir, path3);
  }
};
var RemoteWorkspace = class {
  host;
  apiKey;
  workingDir;
  readTimeoutSeconds;
  constructor(options) {
    this.host = options.host.replace(/\/+$/u, "");
    this.apiKey = options.apiKey ?? options.api_key ?? null;
    this.workingDir = remotePath(options.workingDir ?? options.working_dir ?? "workspace/project");
    this.readTimeoutSeconds = options.readTimeoutSeconds ?? options.read_timeout ?? 600;
  }
  async alive() {
    try {
      const response = await fetch(`${this.host}/health`, { signal: AbortSignal.timeout(5e3) });
      return response.ok;
    } catch {
      return false;
    }
  }
  async getServerInfo() {
    const response = await this.request("/server_info");
    const data = await response.json();
    return isRecord9(data) ? data : {};
  }
  async executeCommand(command, options = {}) {
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const payload = { command, timeout: Math.trunc(timeoutSeconds) };
    payload.cwd = options.cwd === void 0 || options.cwd === null ? this.workingDir : joinRemotePath(this.workingDir, options.cwd);
    try {
      const start = await this.request("/api/bash/start_bash_command", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        timeoutMs: (timeoutSeconds + 5) * 1e3
      });
      const started = await start.json();
      if (started.id === void 0) {
        throw new Error("agent-server did not return a bash command id");
      }
      const stdoutParts = [];
      const stderrParts = [];
      const seen = /* @__PURE__ */ new Set();
      let exitCode = null;
      let lastOrder = -1;
      const deadline = Date.now() + timeoutSeconds * 1e3;
      while (Date.now() < deadline) {
        const params = new URLSearchParams({ command_id__eq: started.id, sort_order: "TIMESTAMP", limit: "100", kind__eq: "BashOutput" });
        if (lastOrder >= 0) {
          params.set("order__gt", String(lastOrder));
        }
        const response = await this.request(`/api/bash/bash_events/search?${params.toString()}`, { timeoutMs: this.readTimeoutSeconds * 1e3 });
        const result = await response.json();
        for (const event of result.items ?? []) {
          if (event.kind !== "BashOutput") {
            continue;
          }
          if (typeof event.id === "string") {
            if (seen.has(event.id)) {
              throw new Error(`Duplicate bash event received: ${event.id}`);
            }
            seen.add(event.id);
          }
          if (typeof event.order === "number" && event.order > lastOrder) {
            lastOrder = event.order;
          }
          if (typeof event.stdout === "string") {
            stdoutParts.push(event.stdout);
          }
          if (typeof event.stderr === "string") {
            stderrParts.push(event.stderr);
          }
          if (typeof event.exit_code === "number") {
            exitCode = event.exit_code;
          }
        }
        if (exitCode !== null) {
          break;
        }
        await delay(100);
      }
      if (exitCode === null) {
        exitCode = -1;
        stderrParts.push(`Command timed out after ${timeoutSeconds} seconds`);
      }
      const stderr = stderrParts.join("");
      return { command, exitCode, stdout: stdoutParts.join(""), stderr, timeoutOccurred: exitCode === -1 && stderr.includes("timed out") };
    } catch (error) {
      return { command, exitCode: -1, stdout: "", stderr: `Remote execution error: ${error instanceof Error ? error.message : String(error)}`, timeoutOccurred: false };
    }
  }
  async fileUpload(sourcePath, destinationPath) {
    const source = path2.resolve(sourcePath);
    const destination = joinRemotePath(this.workingDir, destinationPath);
    try {
      const content = await promises.readFile(source);
      const form = new FormData();
      form.set("file", new Blob([content]), source.split(/[\\/]/u).at(-1) ?? "file");
      const params = new URLSearchParams({ path: destination });
      const response = await this.request(`/api/file/upload?${params.toString()}`, { method: "POST", body: form, timeoutMs: 6e4 });
      const data = await response.json().catch(() => ({}));
      const result = { success: data.success !== false, sourcePath: source, destinationPath: destination, fileSize: typeof data.file_size === "number" ? data.file_size : content.length };
      if (typeof data.error === "string") {
        return { ...result, error: data.error };
      }
      return result;
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async fileDownload(sourcePath, destinationPath) {
    const source = joinRemotePath(this.workingDir, sourcePath);
    const destination = path2.resolve(destinationPath);
    try {
      const params = new URLSearchParams({ path: source });
      const response = await this.request(`/api/file/download?${params.toString()}`, { timeoutMs: 6e4 });
      const content = Buffer.from(await response.arrayBuffer());
      await promises.mkdir(path2.dirname(destination), { recursive: true });
      await promises.writeFile(destination, content);
      return { success: true, sourcePath: source, destinationPath: destination, fileSize: content.length };
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async gitChanges(path3) {
    const params = new URLSearchParams({ path: joinRemotePath(this.workingDir, path3), ref: "HEAD" });
    const response = await this.request(`/api/git/changes?${params.toString()}`, { timeoutMs: 6e4 });
    return (await response.json()).sort((left, right) => left.path.localeCompare(right.path));
  }
  async gitDiff(path3) {
    const params = new URLSearchParams({ path: joinRemotePath(this.workingDir, path3), ref: "HEAD" });
    const response = await this.request(`/api/git/diff?${params.toString()}`, { timeoutMs: 6e4 });
    return await response.json();
  }
  async pause() {
    return Promise.resolve();
  }
  async resume() {
    return Promise.resolve();
  }
  async request(path3, init = {}) {
    const headers = new Headers(init.headers);
    if (this.apiKey !== null) {
      headers.set("X-Session-API-Key", this.apiKey);
    }
    const response = await fetch(path3.startsWith("http") ? path3 : `${this.host}${path3}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? this.readTimeoutSeconds * 1e3)
    });
    if (!response.ok) {
      throw new Error(`agent-server request failed: ${response.status} ${response.statusText} ${await response.text().catch(() => "")}`.trim());
    }
    return response;
  }
};
function workspace(options = {}) {
  if (options.host !== void 0 && options.host !== null && options.host.length > 0) {
    return new RemoteWorkspace({ ...options, host: options.host });
  }
  return new LocalWorkspace(options);
}
var RepoSource = class {
  url;
  ref;
  provider;
  constructor(options) {
    const source = typeof options === "string" ? { url: options } : options;
    this.url = validateUrl(source.url);
    this.ref = source.ref ?? null;
    this.provider = source.provider ?? null;
    if (isShortUrlFormat(this.url) && this.provider === null) {
      throw new Error(`Short URL format '${this.url}' requires explicit provider field`);
    }
  }
  getProvider() {
    if (this.provider !== null) {
      return this.provider;
    }
    const detected = detectProviderFromUrl(this.url);
    if (detected !== null) {
      return detected;
    }
    throw new Error(`Cannot determine provider for URL: ${this.url}`);
  }
  getTokenName() {
    return providerTokenNames[this.getProvider()];
  }
};
var providerTokenNames = {
  github: "github_token",
  gitlab: "gitlab_token",
  bitbucket: "bitbucket_token"
};
var providerHosts = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org"
};
var providerTokenFormat = {
  github: (token) => `${token}@`,
  gitlab: (token) => `oauth2:${token}@`,
  bitbucket: (token) => `x-token-auth:${token}@`
};
function buildCloneUrl(url, provider, token = null) {
  const host = providerHosts[provider];
  const auth = token === null ? "" : providerTokenFormat[provider](token);
  if (isShortUrlFormat(url)) {
    return `https://${auth}${host}/${url}.git`;
  }
  if (token === null) {
    return url;
  }
  const parsed = new URL(url);
  if (parsed.protocol === "https:" && parsed.host.toLowerCase() === host) {
    parsed.username = auth.endsWith("@") ? auth.slice(0, -1) : auth;
    return parsed.toString();
  }
  return url;
}
function getReposContext(repoMappings) {
  const entries = Object.entries(repoMappings);
  if (entries.length === 0) {
    return "";
  }
  const lines = ["## Cloned Repositories", "", "The following repositories have been cloned to your workspace:", ""];
  for (const [url, mapping] of entries) {
    const ref = mapping.ref === void 0 || mapping.ref === null ? "" : ` (ref: ${mapping.ref})`;
    lines.push(`- \`${mapping.url || url}\`${ref} \u2192 \`${mapping.localPath}/\``);
  }
  lines.push("");
  return lines.join("\n");
}
function validateUrl(value) {
  if (/^[\w-]+\/[\w.-]+$/u.test(value)) {
    return value;
  }
  const normalized = value.startsWith("http://") ? `https://${value.slice(7)}` : value;
  if (normalized.startsWith("https://") || normalized.startsWith("git@") || normalized.startsWith("file://")) {
    return normalized;
  }
  throw new Error("URL must be 'owner/repo' format or a valid git URL (https://, git@, or file://)");
}
function isShortUrlFormat(url) {
  return !url.includes("://") && !url.startsWith("git@");
}
function detectProviderFromUrl(url) {
  if (url.startsWith("git@")) {
    const host = url.split("@")[1]?.split(":")[0]?.toLowerCase();
    return providerFromHost(host ?? "");
  }
  try {
    return providerFromHost(new URL(url).host.toLowerCase());
  } catch {
    return null;
  }
}
function providerFromHost(host) {
  for (const [provider, providerHost] of Object.entries(providerHosts)) {
    if (host === providerHost) {
      return provider;
    }
  }
  return null;
}
function remotePath(path3) {
  return path3.split(path2.sep).join(path2.posix.sep);
}
function joinRemotePath(base, path3) {
  const pathStr = remotePath(path3);
  if (pathStr.startsWith("/") || /^[a-zA-Z]:\//u.test(pathStr)) {
    return pathStr;
  }
  const baseStr = remotePath(base);
  const prefix = baseStr.startsWith("/") ? "/" : "";
  const parts = [...baseStr.split("/"), ...pathStr.split("/")].filter((part) => part.length > 0 && part !== ".");
  return `${prefix}${parts.join("/")}`;
}
async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function isRecord9(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isExecError3(error) {
  return typeof error === "object" && error !== null && ("stdout" in error || "stderr" in error || "code" in error);
}

// src/index.ts
var VERSION = "0.2.0";

exports.AGENT_PROFILE_SCHEMA_VERSION = AGENT_PROFILE_SCHEMA_VERSION;
exports.AGENT_SETTINGS_SCHEMA_VERSION = AGENT_SETTINGS_SCHEMA_VERSION;
exports.Agent = Agent;
exports.AgentContext = AgentContext;
exports.AgentDefinition = AgentDefinition;
exports.AgentFinishedCritic = AgentFinishedCritic;
exports.AnthropicMessagesClient = AnthropicMessagesClient;
exports.AsyncCallbackWrapper = AsyncCallbackWrapper;
exports.AsyncProcessManager = AsyncProcessManager;
exports.BUILT_IN_TOOLS = BUILT_IN_TOOLS;
exports.BUILT_IN_TOOL_FACTORIES = BUILT_IN_TOOL_FACTORIES;
exports.BrowserTool = BrowserTool;
exports.CONVERSATION_SETTINGS_SCHEMA_VERSION = CONVERSATION_SETTINGS_SCHEMA_VERSION;
exports.ConversationState = ConversationState;
exports.CriticBase = CriticBase;
exports.CriticResult = CriticResult;
exports.DEFAULT_TEXT_CONTENT_LIMIT = DEFAULT_TEXT_CONTENT_LIMIT;
exports.DEFAULT_TRUNCATE_NOTICE = DEFAULT_TRUNCATE_NOTICE;
exports.DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST = DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST;
exports.DuplicateEventError = DuplicateEventError;
exports.EVENTS_DIR = EVENTS_DIR;
exports.EVENT_FILE_PATTERN = EVENT_FILE_PATTERN;
exports.EmptyPatchCritic = EmptyPatchCritic;
exports.EventLog = EventLog;
exports.ExtensionFetchError = ExtensionFetchError;
exports.FULL_STATE_KEY = FULL_STATE_KEY;
exports.FileEditorExecutor = FileEditorExecutor;
exports.FileEditorTool = FileEditorTool;
exports.FinishTool = FinishTool;
exports.GIT_EMPTY_TREE_HASH = GIT_EMPTY_TREE_HASH;
exports.GeminiClient = GeminiClient;
exports.GitChangeStatus = GitChangeStatus;
exports.GitCommandError = GitCommandError;
exports.GitError = GitError;
exports.GitPathError = GitPathError;
exports.GitRepositoryError = GitRepositoryError;
exports.GlobExecutor = GlobExecutor;
exports.GlobTool = GlobTool;
exports.GrepExecutor = GrepExecutor;
exports.GrepTool = GrepTool;
exports.HookConfig = HookConfig;
exports.HookDecision = HookDecision;
exports.HookDefinition = HookDefinition;
exports.HookExecutor = HookExecutor;
exports.HookManager = HookManager;
exports.HookMatcher = HookMatcher;
exports.HookResult = HookResult;
exports.HookTriggerEventType = HookEventType;
exports.HookType = HookType;
exports.InMemoryFileStore = InMemoryFileStore;
exports.InMemorySecretStore = InMemorySecretStore;
exports.InstallationInfo = InstallationInfo;
exports.InstallationMetadata = InstallationMetadata;
exports.LLM_PROFILE_ID_PATTERN = LLM_PROFILE_ID_PATTERN;
exports.LOCK_FILE_NAME = LOCK_FILE_NAME;
exports.LOCK_TIMEOUT_SECONDS = LOCK_TIMEOUT_SECONDS;
exports.LocalConversation = LocalConversation;
exports.LocalFileStore = LocalFileStore;
exports.LocalWorkspace = LocalWorkspace;
exports.LogLevel = LogLevel;
exports.MAX_FILE_SIZE_FOR_GIT_DIFF = MAX_FILE_SIZE_FOR_GIT_DIFF;
exports.MCPError = MCPError;
exports.MCPTimeoutError = MCPTimeoutError;
exports.MCPToolAction = MCPToolAction;
exports.MCPToolDefinition = MCPToolDefinition;
exports.MCPToolExecutor = MCPToolExecutor;
exports.MCPToolObservation = MCPToolObservation;
exports.MacOSKeychainSecretStore = MacOSKeychainSecretStore;
exports.MemoryLRUCache = MemoryLRUCache;
exports.N_CHAR_PREVIEW = N_CHAR_PREVIEW;
exports.NoCondensationAvailableError = NoCondensationAvailableError;
exports.NoOpCondenser = NoOpCondenser;
exports.OPENHANDS_KEYRING_SERVICE = OPENHANDS_KEYRING_SERVICE;
exports.OpenAIChatClient = OpenAIChatClient;
exports.OpenAIResponsesClient = OpenAIResponsesClient;
exports.ParallelToolExecutor = ParallelToolExecutor;
exports.PassCritic = PassCritic;
exports.PendingActionsQueue = PendingActionsQueue;
exports.PipelineCondenser = PipelineCondenser;
exports.RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED = RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED;
exports.RemoteConversation = RemoteConversation;
exports.RemoteWorkspace = RemoteWorkspace;
exports.RepoSource = RepoSource;
exports.RollingCondenser = RollingCondenser;
exports.RootSpan = RootSpan;
exports.SECRET_KEY_PATTERNS = SECRET_KEY_PATTERNS;
exports.SENSITIVE_URL_PARAMS = SENSITIVE_URL_PARAMS;
exports.Skill = Skill;
exports.StuckDetector = StuckDetector;
exports.TaskTrackerExecutor = TaskTrackerExecutor;
exports.TaskTrackerTool = TaskTrackerTool;
exports.TerminalExecutor = TerminalExecutor;
exports.TerminalTool = TerminalTool;
exports.TestLLM = TestLLM;
exports.TestLLMExhaustedError = TestLLMExhaustedError;
exports.ThinkTool = ThinkTool;
exports.ToolDefinition = ToolDefinition;
exports.ToolRegistry = ToolRegistry;
exports.VERSION = VERSION;
exports.ValueError = ValueError;
exports.View = View;
exports.acpAgentProfileSchema = acpAgentProfileSchema;
exports.acpAgentSettingsSchema = acpAgentSettingsSchema;
exports.acpServerKindSchema = acpServerKindSchema;
exports.acpToolCallEventSchema = acpToolCallEventSchema;
exports.actionEventSchema = actionEventSchema;
exports.actionEventsFromMessage = actionEventsFromMessage;
exports.agentErrorEventSchema = agentErrorEventSchema;
exports.agentProfileSchema = agentProfileSchema;
exports.agentSettingsSchema = agentSettingsSchema;
exports.baseObservationSchema = baseObservationSchema;
exports.baseToolObservationSchema = baseToolObservationSchema;
exports.browserActionSchema = browserActionSchema;
exports.browserObservationSchema = browserObservationSchema;
exports.buildAnthropicMessagesBody = buildAnthropicMessagesBody;
exports.buildChatCompletionsBody = buildChatCompletionsBody;
exports.buildCloneUrl = buildCloneUrl;
exports.buildGeminiGenerateContentBody = buildGeminiGenerateContentBody;
exports.buildOpenAIResponsesBody = buildOpenAIResponsesBody;
exports.cancellationToken = cancellationToken;
exports.classifyResponse = classifyResponse;
exports.clearRawLlmFieldsWhenProfileSelected = clearRawLlmFieldsWhenProfileSelected;
exports.condensationRequestSchema = condensationRequestSchema;
exports.condensationRequirement = condensationRequirement;
exports.condensationSchema = condensationSchema;
exports.condensationSummaryEventSchema = condensationSummaryEventSchema;
exports.contentSchema = contentSchema;
exports.contentToString = contentToString;
exports.conversationErrorEventSchema = conversationErrorEventSchema;
exports.conversationExecutionStatus = conversationExecutionStatus;
exports.conversationSettingsSchema = conversationSettingsSchema;
exports.conversationStateUpdateEventSchema = conversationStateUpdateEventSchema;
exports.createAnthropicClientFromProfile = createAnthropicClientFromProfile;
exports.createClientFromProfile = createClientFromProfile;
exports.createGeminiClientFromProfile = createGeminiClientFromProfile;
exports.createMcpTools = createMcpTools;
exports.createOpenAIChatClientFromProfile = createOpenAIChatClientFromProfile;
exports.createOpenAIResponsesClientFromProfile = createOpenAIResponsesClientFromProfile;
exports.criticModeSchema = criticModeSchema;
exports.defaultAgentSettings = defaultAgentSettings;
exports.detectProviderFromBaseUrl = detectProviderFromBaseUrl;
exports.disableLogger = disableLogger;
exports.dispatchLlmResponse = dispatchLlmResponse;
exports.displayJson = displayJson;
exports.dumps = dumps;
exports.endRootSpan = endRootSpan;
exports.eventSchema = eventSchema;
exports.eventsToMessages = eventsToMessages;
exports.executeCommand = executeCommand;
exports.extractActionName = extractActionName;
exports.extractRepoName = extractRepoName;
exports.fetchExtension = fetchExtension;
exports.fetchWithResolution = fetchWithResolution;
exports.fileEditorActionSchema = fileEditorActionSchema;
exports.fileEditorObservationSchema = fileEditorObservationSchema;
exports.finishActionSchema = finishActionSchema;
exports.getAgentFactory = getAgentFactory;
exports.getCachePath = getCachePath;
exports.getChangesInRepo = getChangesInRepo;
exports.getClosestGitRepo = getClosestGitRepo;
exports.getEnv = getEnv;
exports.getFactoryInfo = getFactoryInfo;
exports.getGitDiff = getGitDiff;
exports.getLlmApiKey = getLlmApiKey;
exports.getLogger = getLogger;
exports.getRegisteredAgentDefinitions = getRegisteredAgentDefinitions;
exports.getReposContext = getReposContext;
exports.getValidRef = getValidRef;
exports.globActionSchema = globActionSchema;
exports.globObservationSchema = globObservationSchema;
exports.globalToolRegistry = globalToolRegistry;
exports.grepActionSchema = grepActionSchema;
exports.grepMatchSchema = grepMatchSchema;
exports.grepObservationSchema = grepObservationSchema;
exports.handleDeprecatedModelFields = handleDeprecatedModelFields;
exports.hookEventSchema = hookEventSchema;
exports.hookEventTypeSchema = hookEventTypeSchema;
exports.hookExecutionEventSchema = hookExecutionEventSchema;
exports.imageContent = imageContent;
exports.imageContentSchema = imageContentSchema;
exports.inputMetadataSchema = inputMetadataSchema;
exports.interruptEventSchema = interruptEventSchema;
exports.isAbsolutePathSource = isAbsolutePathSource;
exports.isAcpPatchEdit = isAcpPatchEdit;
exports.isConversationStateUpdateEvent = isConversationStateUpdateEvent;
exports.isEnabledFor = isEnabledFor;
exports.isGitUrl = isGitUrl;
exports.isHostAbsolutePath = isHostAbsolutePath;
exports.isLocalPathSource = isLocalPathSource;
exports.isMessageEvent = isMessageEvent;
exports.isSecretKey = isSecretKey;
exports.keywordTriggerSchema = keywordTriggerSchema;
exports.listRegisteredTools = listRegisteredTools;
exports.listUsableTools = listUsableTools;
exports.llmCompletionLogEventSchema = llmCompletionLogEventSchema;
exports.llmCompletionResponseSchema = llmCompletionResponseSchema;
exports.llmConvertibleEventSchema = llmConvertibleEventSchema;
exports.llmProfileIdSchema = llmProfileIdSchema;
exports.llmProfileSchema = llmProfileSchema;
exports.llmProfileSecretRef = llmProfileSecretRef;
exports.llmProviderIdSchema = llmProviderIdSchema;
exports.llmProviderSecretRef = llmProviderSecretRef;
exports.llmResponseType = llmResponseType;
exports.llmUsageSchema = llmUsageSchema;
exports.loadAgentsFromDir = loadAgentsFromDir;
exports.loadAgentsFromDirs = loadAgentsFromDirs;
exports.loadProjectAgents = loadProjectAgents;
exports.loadSkillsFromDir = loadSkillsFromDir;
exports.loadUserAgents = loadUserAgents;
exports.loads = loads;
exports.maybeInitLaminar = maybeInitLaminar;
exports.maybeTruncate = maybeTruncate;
exports.mergeSkillsByName = mergeSkillsByName;
exports.messageEventSchema = messageEventSchema;
exports.messageSchema = messageSchema;
exports.messageToolCallSchema = messageToolCallSchema;
exports.normalizeGitUrl = normalizeGitUrl;
exports.observabilityEnvKeys = observabilityEnvKeys;
exports.observabilityMetadataSchema = observabilityMetadataSchema;
exports.observabilityTagsSchema = observabilityTagsSchema;
exports.observationEventSchema = observationEventSchema;
exports.observe = observe;
exports.openAiApiModeSchema = openAiApiModeSchema;
exports.openHandsAgentProfileSchema = openHandsAgentProfileSchema;
exports.openHandsAgentSettingsSchema = openHandsAgentSettingsSchema;
exports.pageIterator = pageIterator;
exports.parseExtensionSource = parseExtensionSource;
exports.pauseEventSchema = pauseEventSchema;
exports.posixPathName = posixPathName;
exports.profileVerificationSettingsSchema = profileVerificationSettingsSchema;
exports.promptCacheRetentionSchema = promptCacheRetentionSchema;
exports.reasoningEffortSchema = reasoningEffortSchema;
exports.reasoningItemSchema = reasoningItemSchema;
exports.reasoningSummarySchema = reasoningSummarySchema;
exports.redactTextSecrets = redactTextSecrets;
exports.redactUrlCredentials = redactUrlCredentials;
exports.redactUrlCredentialsInText = redactUrlCredentialsInText;
exports.redactUrlParams = redactUrlParams;
exports.redactedThinkingBlockSchema = redactedThinkingBlockSchema;
exports.reduceTextContent = reduceTextContent;
exports.registerAgent = registerAgent;
exports.registerAgentIfAbsent = registerAgentIfAbsent;
exports.registerTool = registerTool;
exports.registerToolFactory = registerToolFactory;
exports.resetAgentRegistryForTests = resetAgentRegistryForTests;
exports.resolveLlmApiKeyRef = resolveLlmApiKeyRef;
exports.resolveLlmProfileApiKeyRef = resolveLlmProfileApiKeyRef;
exports.resolveProviderFromProfile = resolveProviderFromProfile;
exports.resolveTool = resolveTool;
exports.restoreConversationState = restoreConversationState;
exports.resumeTranscriptEventSchema = resumeTranscriptEventSchema;
exports.runGitCommand = runGitCommand;
exports.sanitizeOpenHandsMentions = sanitizeOpenHandsMentions;
exports.sanitizedEnv = sanitizedEnv;
exports.secretRefSchema = secretRefSchema;
exports.setupLogging = setupLogging;
exports.shouldEnableObservability = shouldEnableObservability;
exports.skillResourcesSchema = skillResourcesSchema;
exports.skillSchema = skillSchema;
exports.skillsToPrompt = skillsToPrompt;
exports.sourceTypeSchema = sourceTypeSchema;
exports.startRootSpan = startRootSpan;
exports.streamingDeltaEventSchema = streamingDeltaEventSchema;
exports.systemPromptEventSchema = systemPromptEventSchema;
exports.taskItemSchema = taskItemSchema;
exports.taskTrackerActionSchema = taskTrackerActionSchema;
exports.taskTrackerObservationSchema = taskTrackerObservationSchema;
exports.taskTriggerSchema = taskTriggerSchema;
exports.terminalActionSchema = terminalActionSchema;
exports.terminalObservationSchema = terminalObservationSchema;
exports.textContent = textContent;
exports.textContentSchema = textContentSchema;
exports.thinkActionSchema = thinkActionSchema;
exports.thinkingBlockSchema = thinkingBlockSchema;
exports.toCamelCase = toCamelCase;
exports.toLLMMessage = toLLMMessage;
exports.toPosixPath = toPosixPath;
exports.tokenEventSchema = tokenEventSchema;
exports.toolAnnotationsSchema = toolAnnotationsSchema;
exports.toolSpecSchema = toolSpecSchema;
exports.triggerSchema = triggerSchema;
exports.userRejectObservationSchema = userRejectObservationSchema;
exports.utcNow = utcNow;
exports.validateAgentProfile = validateAgentProfile;
exports.validateAgentSettings = validateAgentSettings;
exports.validateConversationSettings = validateConversationSettings;
exports.validateExtensionName = validateExtensionName;
exports.validateGitRepository = validateGitRepository;
exports.workspace = workspace;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map