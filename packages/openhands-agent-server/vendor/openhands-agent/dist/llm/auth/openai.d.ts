import { type SubscriptionLoginOptions } from './login.js';
import { CredentialStore, OAuthCredentials } from './credentials.js';
import type { FetchResponseLike } from '../client.js';
export declare const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const ISSUER = "https://auth.openai.com";
export declare const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export declare const DEVICE_CODE_TIMEOUT_SECONDS = 900;
export declare const OAUTH_TIMEOUT_SECONDS = 300;
export declare const DEFAULT_OAUTH_PORT = 1455;
export declare const OPENAI_CODEX_MODELS: readonly string[];
export declare const CONSENT_BANNER = "Signing in with ChatGPT uses your ChatGPT account. By continuing, you confirm you are a ChatGPT End User and are subject to OpenAI's Terms of Use.\nhttps://openai.com/policies/terms-of-use/\n";
export type DeviceCode = {
    readonly verification_url: string;
    readonly user_code: string;
    readonly device_auth_id: string;
    readonly interval: number;
};
export type OAuthFetch = (url: string, init: {
    method: 'POST' | 'GET';
    headers: Readonly<Record<string, string>>;
    body?: string;
}) => Promise<FetchResponseLike>;
export declare function generatePKCE(): {
    verifier: string;
    challenge: string;
};
export declare function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string;
export interface OpenAISubscriptionAuthOptions {
    credentialStore?: CredentialStore;
    fetch?: OAuthFetch;
    now?: () => number;
}
/** Shared OAuth lifecycle. Server handlers own pending-login sessions; the SDK owns tokens. */
export declare class OpenAISubscriptionAuth {
    readonly vendor = "openai";
    private readonly store;
    private readonly fetchImpl;
    private readonly now;
    private refreshPromise;
    private generation;
    private jwks;
    constructor(options?: OpenAISubscriptionAuthOptions);
    login(options?: SubscriptionLoginOptions): Promise<OAuthCredentials>;
    getCredentials(): OAuthCredentials | null;
    hasValidCredentials(): boolean;
    saveCredentials(credentials: OAuthCredentials): void;
    logout(): boolean;
    refreshIfNeeded(): Promise<OAuthCredentials | null>;
    private request;
    private tokenRequest;
    startDeviceLogin(): Promise<DeviceCode>;
    pollDeviceLogin(deviceCode: DeviceCode, options?: {
        persist?: boolean;
    }): Promise<OAuthCredentials | null>;
    exchangeCode(code: string, redirectUri: string, verifier: string, persist?: boolean): Promise<OAuthCredentials>;
    extractChatGPTAccountId(credentials: OAuthCredentials): Promise<string | null>;
}
export declare const DEFAULT_SYSTEM_MESSAGE = "You are OpenHands agent, a helpful AI assistant that can interact with a computer to solve tasks.";
export declare function injectSystemPrefix(inputItems: Record<string, unknown>[], prefixContent: Record<string, unknown>): void;
export declare function transformForSubscription(systemChunks: readonly string[], inputItems: Record<string, unknown>[]): [string, Record<string, unknown>[]];
