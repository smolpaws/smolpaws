import { type DeviceCode, type OpenAISubscriptionAuth } from './openai.js';
import type { OAuthCredentials } from './credentials.js';
export type SubscriptionLoginOptions = {
    authMethod?: 'browser' | 'device_code';
    oauthPort?: number;
    timeoutSeconds?: number;
    /** The host displays consent and opens/displays this URL. No credentials are logged. */
    onAuthorize?: (url: string) => void | Promise<void>;
    /** The host privately displays the one-time code and verification URL. */
    onDeviceCode?: (code: DeviceCode) => void | Promise<void>;
};
export declare function login(auth: OpenAISubscriptionAuth, options: SubscriptionLoginOptions): Promise<OAuthCredentials>;
