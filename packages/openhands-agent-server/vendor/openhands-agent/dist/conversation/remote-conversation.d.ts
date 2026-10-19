import { type ConversationObservabilityOptions } from '../observability/index.js';
import type { WorkspaceCompletionRegistration } from '../workspace/completion-callback.js';
import { type Message } from '../llm/index.js';
import { type AgentSettings } from '../settings/index.js';
import type { HookConfig, HookConfigInput } from '../hooks/index.js';
import { ConversationState } from './state.js';
export interface RemoteFetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
export interface RemoteFetchLike {
    request(url: string, init: {
        readonly method: string;
        readonly headers?: Readonly<Record<string, string>>;
        readonly body?: string;
    }): Promise<RemoteFetchResponseLike>;
}
export interface RemoteConversationOptions extends ConversationObservabilityOptions {
    readonly workspace?: WorkspaceCompletionRegistration | undefined;
    readonly host: string;
    readonly conversationId: string;
    readonly fetch?: RemoteFetchLike;
    readonly apiKey?: string | null;
    readonly state?: ConversationState;
    readonly toolModuleQualnames?: Readonly<Record<string, string>>;
}
export interface RemoteConversationCreateRequest {
    readonly observabilityParentSpanContext?: string | null;
    readonly workspace: {
        readonly kind: 'LocalWorkspace';
        readonly working_dir: string;
    };
    readonly worktree?: boolean;
    readonly parentConversationId?: string | null;
    readonly initialMessage?: {
        readonly role?: Message['role'];
        readonly content: Message['content'];
        readonly run?: boolean;
    } | null;
    readonly stuckDetection?: boolean;
    readonly hookConfig?: HookConfig | HookConfigInput | null;
    readonly agentLaunchAdditions?: {
        readonly system_message_suffix_append?: string | null;
    } | null;
    readonly userId?: string | null;
    readonly observabilityMetadata?: Readonly<Record<string, unknown>> | null;
    readonly observabilityTags?: readonly string[] | null;
    readonly observabilitySpanName?: string | null;
    readonly autotitle?: boolean;
    readonly titleLlmProfile?: string | null;
    readonly title?: string | null;
    readonly persistenceDir?: string | null;
    readonly agentProfileId?: string | null;
    readonly agentSettings?: AgentSettings | null;
    readonly conversationId?: string | null;
    readonly maxIterations?: number | null;
    readonly tags?: Readonly<Record<string, string>> | null;
}
export interface RemoteConversationCreateOptions {
    readonly observability?: ConversationObservabilityOptions['observability'];
    readonly workspace?: WorkspaceCompletionRegistration | undefined;
    /** SmolPaws accepts TS AgentSettings as `agent`; Python accepts a saved Agent Profile UUID. */
    readonly server?: 'smolpaws' | 'python';
    readonly host: string;
    readonly request: RemoteConversationCreateRequest;
    readonly fetch?: RemoteFetchLike;
    readonly apiKey?: string | null;
    readonly state?: ConversationState;
}
export interface RemoteConversationAttachOptions extends ConversationObservabilityOptions {
    readonly workspace?: WorkspaceCompletionRegistration | undefined;
    readonly host: string;
    readonly conversationId: string;
    readonly fetch?: RemoteFetchLike;
    readonly apiKey?: string | null;
    readonly state?: ConversationState;
}
export interface RemoteRunOptions {
    readonly blocking?: boolean;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
}
export declare class RemoteConversation {
    private readonly rootSpan;
    private readonly workspace;
    private closed;
    readonly host: string;
    readonly id: string;
    readonly state: ConversationState;
    /** Remote Python module metadata is data; native event decoding never imports it. */
    readonly toolModuleQualnames: Readonly<Record<string, string>>;
    private syncTail;
    private readonly fetcher;
    private readonly apiKey;
    constructor(options: RemoteConversationOptions);
    static create(options: RemoteConversationCreateOptions): Promise<RemoteConversation>;
    static attach(options: RemoteConversationAttachOptions): Promise<RemoteConversation>;
    private static fromInfo;
    close(): void;
    /** Explicit initial/reconciliation sync for direct synchronous proxy construction. */
    syncEvents(): Promise<void>;
    sendMessage(message: string | Message, sender?: string): Promise<void>;
    run(options?: RemoteRunOptions): Promise<void>;
    condense(): Promise<void>;
    pause(): Promise<void>;
    interrupt(): Promise<void>;
    setTitle(title: string): Promise<void>;
    private waitForRunCompletion;
    private pollStatus;
    private request;
    private get actionBasePath();
    private get infoPath();
}
