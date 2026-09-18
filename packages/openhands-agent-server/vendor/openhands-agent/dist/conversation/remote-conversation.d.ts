import { type Message } from '../llm/index.js';
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
export interface RemoteConversationOptions {
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
    readonly host: string;
    readonly id: string;
    readonly state: ConversationState;
    private readonly fetcher;
    private readonly apiKey;
    constructor(options: RemoteConversationOptions);
    sendMessage(message: string | Message, sender?: string): Promise<void>;
    run(options?: RemoteRunOptions): Promise<void>;
    condense(): Promise<void>;
    pause(): Promise<void>;
    interrupt(): Promise<void>;
    private waitForRunCompletion;
    private pollStatus;
    private request;
    private get actionBasePath();
    private get infoPath();
}
