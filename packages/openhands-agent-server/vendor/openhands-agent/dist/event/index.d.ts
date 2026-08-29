import { z } from 'zod';
import { type Message } from '../llm/index.js';
export declare const N_CHAR_PREVIEW = 500;
export declare const FULL_STATE_KEY = "full_state";
export declare const sourceTypeSchema: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
export declare const ROOT_PARENT_ID = "__root__";
export declare const tokenEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"TokenEvent">>;
    prompt_token_ids: z.ZodArray<z.ZodNumber>;
    response_token_ids: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>;
export declare const streamingDeltaEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"StreamingDeltaEvent">>;
    content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const conversationErrorEventSchema: z.ZodPipe<z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ConversationErrorEvent">>;
    code: z.ZodString;
    detail: z.ZodString;
    classification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
        retryable: z.ZodBoolean;
        user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
        error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<{
    id: string;
    timestamp: string;
    source: "user" | "agent" | "environment" | "hook";
    parent_id: string | null;
    kind: "ConversationErrorEvent";
    code: string;
    detail: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
}, {
    id: string;
    timestamp: string;
    source: "user" | "agent" | "environment" | "hook";
    parent_id: string | null;
    kind: "ConversationErrorEvent";
    code: string;
    detail: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
}>>;
export declare const llmCompletionLogEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"LLMCompletionLogEvent">>;
    filename: z.ZodString;
    log_data: z.ZodString;
    model_name: z.ZodDefault<z.ZodString>;
    usage_id: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
export declare const pauseEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"PauseEvent">>;
}, z.core.$strict>;
export declare const interruptEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"InterruptEvent">>;
}, z.core.$strict>;
export declare const conversationStateUpdateEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ConversationStateUpdateEvent">>;
    key: z.ZodDefault<z.ZodString>;
    value: z.ZodDefault<z.ZodUnknown>;
}, z.core.$strict>;
export declare const systemPromptEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"SystemPromptEvent">>;
    system_prompt: z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>;
    tools: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    dynamic_context: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>>>;
}, z.core.$strict>;
export declare const messageEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"MessageEvent">>;
    llm_message: z.ZodPipe<z.ZodObject<{
        role: z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"system">, z.ZodLiteral<"assistant">, z.ZodLiteral<"tool">]>;
        content: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"text">>;
            text: z.ZodString;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "text";
            text: string;
        }, {
            cache_prompt: boolean;
            type: "text";
            text: string;
            enable_truncation?: boolean | undefined;
        }>>, z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"image">>;
            image_urls: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        }, {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
            enable_truncation?: boolean | undefined;
        }>>]>>, z.ZodNull]>>, z.ZodTransform<({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[], string | ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[] | null>>;
        tool_calls: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            name: z.ZodString;
            arguments: z.ZodString;
            origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
        }, z.core.$strict>>>>;
        tool_call_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        cache_enabled: z.ZodOptional<z.ZodBoolean>;
        vision_enabled: z.ZodOptional<z.ZodBoolean>;
        function_calling_enabled: z.ZodOptional<z.ZodBoolean>;
        force_string_serializer: z.ZodOptional<z.ZodBoolean>;
        send_reasoning_content: z.ZodOptional<z.ZodBoolean>;
        reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"thinking">>;
            thinking: z.ZodString;
            signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
            data: z.ZodString;
        }, z.core.$strict>]>>>;
        responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
            content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
            encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>, z.ZodTransform<{
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
    }, {
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
        cache_enabled?: boolean | undefined;
        vision_enabled?: boolean | undefined;
        function_calling_enabled?: boolean | undefined;
        force_string_serializer?: boolean | undefined;
        send_reasoning_content?: boolean | undefined;
    }>>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    activated_skills: z.ZodDefault<z.ZodArray<z.ZodString>>;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    sender: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    critic_result: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>;
export declare const actionEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ActionEvent">>;
    thought: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    action: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    tool_call: z.ZodObject<{
        id: z.ZodString;
        responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodString;
        arguments: z.ZodString;
        origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
    }, z.core.$strict>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"thinking">>;
        thinking: z.ZodString;
        signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
        data: z.ZodString;
    }, z.core.$strict>]>>>;
    responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
        content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
        encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const observationEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ObservationEvent">>;
    observation: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    action_id: z.ZodString;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
}, z.core.$strict>;
export declare const userRejectObservationSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"UserRejectObservation">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    rejection_reason: z.ZodDefault<z.ZodString>;
    rejection_source: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"hook">]>>;
    action_id: z.ZodString;
}, z.core.$strict>;
export declare const agentErrorEventSchema: z.ZodPipe<z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"AgentErrorEvent">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    error: z.ZodString;
    classification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
        retryable: z.ZodBoolean;
        user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
        error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<{
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}, {
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}>>;
export declare const condensationSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"Condensation">>;
    summary: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    summary_offset: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    forgotten_event_ids: z.ZodPipe<z.ZodUnion<readonly [z.ZodSet<z.ZodString>, z.ZodArray<z.ZodString>]>, z.ZodTransform<Set<string>, string[] | Set<string>>>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const condensationRequestSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"CondensationRequest">>;
}, z.core.$strict>;
export declare const condensationSummaryEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"CondensationSummaryEvent">>;
    summary: z.ZodString;
}, z.core.$strict>;
export declare const acpToolCallEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ACPToolCallEvent">>;
    tool_call_id: z.ZodString;
    title: z.ZodString;
    status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tool_kind: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    raw_input: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
    raw_output: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
    content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodUnknown>>>;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const hookEventTypeSchema: z.ZodUnion<readonly [z.ZodLiteral<"PreToolUse">, z.ZodLiteral<"PostToolUse">, z.ZodLiteral<"UserPromptSubmit">, z.ZodLiteral<"SessionStart">, z.ZodLiteral<"SessionEnd">, z.ZodLiteral<"Stop">]>;
export declare const hookExecutionEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"HookExecutionEvent">>;
    hook_event_type: z.ZodUnion<readonly [z.ZodLiteral<"PreToolUse">, z.ZodLiteral<"PostToolUse">, z.ZodLiteral<"UserPromptSubmit">, z.ZodLiteral<"SessionStart">, z.ZodLiteral<"SessionEnd">, z.ZodLiteral<"Stop">]>;
    hook_command: z.ZodString;
    tool_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    success: z.ZodBoolean;
    blocked: z.ZodDefault<z.ZodBoolean>;
    exit_code: z.ZodNumber;
    stdout: z.ZodDefault<z.ZodString>;
    stderr: z.ZodDefault<z.ZodString>;
    reason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    additional_context: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    error: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    action_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    message_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    hook_input: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strict>;
export declare const resumeTranscriptEventSchema: z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ResumeTranscriptEvent">>;
    transcript: z.ZodDefault<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strict>;
export declare const eventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"TokenEvent">>;
    prompt_token_ids: z.ZodArray<z.ZodNumber>;
    response_token_ids: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"StreamingDeltaEvent">>;
    content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>, z.ZodPipe<z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ConversationErrorEvent">>;
    code: z.ZodString;
    detail: z.ZodString;
    classification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
        retryable: z.ZodBoolean;
        user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
        error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<{
    id: string;
    timestamp: string;
    source: "user" | "agent" | "environment" | "hook";
    parent_id: string | null;
    kind: "ConversationErrorEvent";
    code: string;
    detail: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
}, {
    id: string;
    timestamp: string;
    source: "user" | "agent" | "environment" | "hook";
    parent_id: string | null;
    kind: "ConversationErrorEvent";
    code: string;
    detail: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
}>>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"LLMCompletionLogEvent">>;
    filename: z.ZodString;
    log_data: z.ZodString;
    model_name: z.ZodDefault<z.ZodString>;
    usage_id: z.ZodDefault<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"PauseEvent">>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"InterruptEvent">>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ConversationStateUpdateEvent">>;
    key: z.ZodDefault<z.ZodString>;
    value: z.ZodDefault<z.ZodUnknown>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"SystemPromptEvent">>;
    system_prompt: z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>;
    tools: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    dynamic_context: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"MessageEvent">>;
    llm_message: z.ZodPipe<z.ZodObject<{
        role: z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"system">, z.ZodLiteral<"assistant">, z.ZodLiteral<"tool">]>;
        content: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"text">>;
            text: z.ZodString;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "text";
            text: string;
        }, {
            cache_prompt: boolean;
            type: "text";
            text: string;
            enable_truncation?: boolean | undefined;
        }>>, z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"image">>;
            image_urls: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        }, {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
            enable_truncation?: boolean | undefined;
        }>>]>>, z.ZodNull]>>, z.ZodTransform<({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[], string | ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[] | null>>;
        tool_calls: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            name: z.ZodString;
            arguments: z.ZodString;
            origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
        }, z.core.$strict>>>>;
        tool_call_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        cache_enabled: z.ZodOptional<z.ZodBoolean>;
        vision_enabled: z.ZodOptional<z.ZodBoolean>;
        function_calling_enabled: z.ZodOptional<z.ZodBoolean>;
        force_string_serializer: z.ZodOptional<z.ZodBoolean>;
        send_reasoning_content: z.ZodOptional<z.ZodBoolean>;
        reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"thinking">>;
            thinking: z.ZodString;
            signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
            data: z.ZodString;
        }, z.core.$strict>]>>>;
        responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
            content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
            encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>, z.ZodTransform<{
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
    }, {
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
        cache_enabled?: boolean | undefined;
        vision_enabled?: boolean | undefined;
        function_calling_enabled?: boolean | undefined;
        force_string_serializer?: boolean | undefined;
        send_reasoning_content?: boolean | undefined;
    }>>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    activated_skills: z.ZodDefault<z.ZodArray<z.ZodString>>;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    sender: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    critic_result: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ActionEvent">>;
    thought: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    action: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    tool_call: z.ZodObject<{
        id: z.ZodString;
        responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodString;
        arguments: z.ZodString;
        origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
    }, z.core.$strict>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"thinking">>;
        thinking: z.ZodString;
        signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
        data: z.ZodString;
    }, z.core.$strict>]>>>;
    responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
        content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
        encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ObservationEvent">>;
    observation: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    action_id: z.ZodString;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"UserRejectObservation">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    rejection_reason: z.ZodDefault<z.ZodString>;
    rejection_source: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"hook">]>>;
    action_id: z.ZodString;
}, z.core.$strict>, z.ZodPipe<z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"AgentErrorEvent">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    error: z.ZodString;
    classification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
        retryable: z.ZodBoolean;
        user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
        error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<{
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}, {
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}>>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"Condensation">>;
    summary: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    summary_offset: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    forgotten_event_ids: z.ZodPipe<z.ZodUnion<readonly [z.ZodSet<z.ZodString>, z.ZodArray<z.ZodString>]>, z.ZodTransform<Set<string>, string[] | Set<string>>>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"CondensationRequest">>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"CondensationSummaryEvent">>;
    summary: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ACPToolCallEvent">>;
    tool_call_id: z.ZodString;
    title: z.ZodString;
    status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tool_kind: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    raw_input: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
    raw_output: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
    content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodUnknown>>>;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"HookExecutionEvent">>;
    hook_event_type: z.ZodUnion<readonly [z.ZodLiteral<"PreToolUse">, z.ZodLiteral<"PostToolUse">, z.ZodLiteral<"UserPromptSubmit">, z.ZodLiteral<"SessionStart">, z.ZodLiteral<"SessionEnd">, z.ZodLiteral<"Stop">]>;
    hook_command: z.ZodString;
    tool_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    success: z.ZodBoolean;
    blocked: z.ZodDefault<z.ZodBoolean>;
    exit_code: z.ZodNumber;
    stdout: z.ZodDefault<z.ZodString>;
    stderr: z.ZodDefault<z.ZodString>;
    reason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    additional_context: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    error: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    action_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    message_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    hook_input: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ResumeTranscriptEvent">>;
    transcript: z.ZodDefault<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strict>], "kind">;
export declare const llmConvertibleEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"SystemPromptEvent">>;
    system_prompt: z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>;
    tools: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    dynamic_context: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]> & z.ZodType<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }, z.core.$ZodTypeInternals<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        text: string;
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "text" | undefined;
    } | {
        image_urls: string[];
        cache_prompt?: boolean | undefined;
        enable_truncation?: boolean | undefined;
        type?: "image" | undefined;
    }>>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: z.ZodUnion<readonly [z.ZodLiteral<"agent">, z.ZodLiteral<"user">, z.ZodLiteral<"environment">, z.ZodLiteral<"hook">]>;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"MessageEvent">>;
    llm_message: z.ZodPipe<z.ZodObject<{
        role: z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"system">, z.ZodLiteral<"assistant">, z.ZodLiteral<"tool">]>;
        content: z.ZodPipe<z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"text">>;
            text: z.ZodString;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "text";
            text: string;
        }, {
            cache_prompt: boolean;
            type: "text";
            text: string;
            enable_truncation?: boolean | undefined;
        }>>, z.ZodPipe<z.ZodObject<{
            cache_prompt: z.ZodDefault<z.ZodBoolean>;
            enable_truncation: z.ZodOptional<z.ZodBoolean>;
            type: z.ZodDefault<z.ZodLiteral<"image">>;
            image_urls: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodTransform<{
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        }, {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
            enable_truncation?: boolean | undefined;
        }>>]>>, z.ZodNull]>>, z.ZodTransform<({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[], string | ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[] | null>>;
        tool_calls: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            name: z.ZodString;
            arguments: z.ZodString;
            origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
        }, z.core.$strict>>>>;
        tool_call_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        cache_enabled: z.ZodOptional<z.ZodBoolean>;
        vision_enabled: z.ZodOptional<z.ZodBoolean>;
        function_calling_enabled: z.ZodOptional<z.ZodBoolean>;
        force_string_serializer: z.ZodOptional<z.ZodBoolean>;
        send_reasoning_content: z.ZodOptional<z.ZodBoolean>;
        reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"thinking">>;
            thinking: z.ZodString;
            signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
            data: z.ZodString;
        }, z.core.$strict>]>>>;
        responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
            content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
            encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
            status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>, z.ZodTransform<{
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
    }, {
        role: "user" | "system" | "assistant" | "tool";
        content: ({
            cache_prompt: boolean;
            type: "text";
            text: string;
        } | {
            cache_prompt: boolean;
            type: "image";
            image_urls: string[];
        })[];
        tool_calls: {
            id: string;
            responses_item_id: string | null;
            name: string;
            arguments: string;
            origin: "responses" | "completion";
        }[] | null;
        tool_call_id: string | null;
        name: string | null;
        reasoning_content: string | null;
        thinking_blocks: ({
            type: "thinking";
            thinking: string;
            signature: string | null;
        } | {
            type: "redacted_thinking";
            data: string;
        })[];
        responses_reasoning_item: {
            id: string | null;
            summary: string[];
            content: string[] | null;
            encrypted_content: string | null;
            status: string | null;
        } | null;
        cache_enabled?: boolean | undefined;
        vision_enabled?: boolean | undefined;
        function_calling_enabled?: boolean | undefined;
        force_string_serializer?: boolean | undefined;
        send_reasoning_content?: boolean | undefined;
    }>>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    activated_skills: z.ZodDefault<z.ZodArray<z.ZodString>>;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    sender: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    critic_result: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ActionEvent">>;
    thought: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
    action: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    tool_call: z.ZodObject<{
        id: z.ZodString;
        responses_item_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        name: z.ZodString;
        arguments: z.ZodString;
        origin: z.ZodUnion<readonly [z.ZodLiteral<"completion">, z.ZodLiteral<"responses">]>;
    }, z.core.$strict>;
    llm_response_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    reasoning_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    thinking_blocks: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"thinking">>;
        thinking: z.ZodString;
        signature: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"redacted_thinking">>;
        data: z.ZodString;
    }, z.core.$strict>]>>>;
    responses_reasoning_item: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        summary: z.ZodDefault<z.ZodArray<z.ZodString>>;
        content: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
        encrypted_content: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        status: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"ObservationEvent">>;
    observation: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    action_id: z.ZodString;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    extended_content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>, z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"image">>;
        image_urls: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
    }, {
        cache_prompt: boolean;
        type: "image";
        image_urls: string[];
        enable_truncation?: boolean | undefined;
    }>>]>>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"UserRejectObservation">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    rejection_reason: z.ZodDefault<z.ZodString>;
    rejection_source: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"user">, z.ZodLiteral<"hook">]>>;
    action_id: z.ZodString;
}, z.core.$strict>, z.ZodPipe<z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"AgentErrorEvent">>;
    tool_name: z.ZodString;
    tool_call_id: z.ZodString;
    error: z.ZodString;
    classification: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        kind: z.ZodUnion<readonly [z.ZodLiteral<"auth">, z.ZodLiteral<"quota">, z.ZodLiteral<"rate_limit">, z.ZodLiteral<"config">, z.ZodLiteral<"transient">, z.ZodLiteral<"agent_action">, z.ZodLiteral<"internal">, z.ZodLiteral<"unknown">]>;
        retryable: z.ZodBoolean;
        user_action: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"retry">, z.ZodLiteral<"settings">]>>;
        error_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<{
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}, {
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "AgentErrorEvent";
    tool_name: string;
    tool_call_id: string;
    error: string;
    classification: {
        kind: "unknown" | "auth" | "quota" | "rate_limit" | "config" | "transient" | "agent_action" | "internal";
        retryable: boolean;
        user_action: "none" | "retry" | "settings";
        error_id: string | null;
    } | null;
    source?: never;
}>>, z.ZodObject<{
    id: z.ZodDefault<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    source: never;
    parent_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    kind: z.ZodDefault<z.ZodLiteral<"CondensationSummaryEvent">>;
    summary: z.ZodString;
}, z.core.$strict>], "kind">;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type Event = z.infer<typeof eventSchema>;
export type TokenEvent = z.infer<typeof tokenEventSchema>;
export type StreamingDeltaEvent = z.infer<typeof streamingDeltaEventSchema>;
export type ConversationErrorEvent = z.infer<typeof conversationErrorEventSchema>;
export type LLMCompletionLogEvent = z.infer<typeof llmCompletionLogEventSchema>;
export type PauseEvent = z.infer<typeof pauseEventSchema>;
export type InterruptEvent = z.infer<typeof interruptEventSchema>;
export type ConversationStateUpdateEvent = z.infer<typeof conversationStateUpdateEventSchema>;
export type SystemPromptEvent = z.infer<typeof systemPromptEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type ActionEvent = z.infer<typeof actionEventSchema>;
export type ObservationEvent = z.infer<typeof observationEventSchema>;
export type UserRejectObservation = z.infer<typeof userRejectObservationSchema>;
export type AgentErrorEvent = z.infer<typeof agentErrorEventSchema>;
export type Condensation = z.infer<typeof condensationSchema>;
export type CondensationRequest = z.infer<typeof condensationRequestSchema>;
export type CondensationSummaryEvent = z.infer<typeof condensationSummaryEventSchema>;
export type ACPToolCallEvent = z.infer<typeof acpToolCallEventSchema>;
export type HookEventType = z.infer<typeof hookEventTypeSchema>;
export type HookExecutionEvent = z.infer<typeof hookExecutionEventSchema>;
export type ResumeTranscriptEvent = z.infer<typeof resumeTranscriptEventSchema>;
export type LLMConvertibleEvent = z.infer<typeof llmConvertibleEventSchema>;
export { AGENT_OUTCOME, classifyError, errorClassificationSchema, failureActionSchema, failureKindSchema, } from './error-classification.js';
export type { ErrorClassification, FailureAction, FailureKind } from './error-classification.js';
export declare function isMessageEvent(event: unknown): event is MessageEvent;
export declare function isConversationStateUpdateEvent(event: unknown): event is ConversationStateUpdateEvent;
export declare function isAcpPatchEdit(event: ACPToolCallEvent): boolean;
export declare function toLLMMessage(event: LLMConvertibleEvent): Message;
export declare function eventsToMessages(events: readonly LLMConvertibleEvent[]): Message[];
