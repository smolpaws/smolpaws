import { z } from 'zod';
export declare const oauthCredentialsSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"oauth">>;
    vendor: z.ZodString;
    access_token: z.ZodString;
    refresh_token: z.ZodString;
    expires_at: z.ZodNumber;
}, z.core.$strip>;
export declare class OAuthCredentials {
    readonly type: "oauth";
    vendor: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    constructor(input: z.input<typeof oauthCredentialsSchema>);
    isExpired(nowMs?: number): boolean;
}
export declare function getCredentialsDir(): string;
/** OAuth tokens live only in this private, Python-compatible store, never in profiles. */
export declare class CredentialStore {
    private readonly directory;
    constructor(directory?: string);
    get credentialsDir(): string;
    private file;
    get(vendor: string): OAuthCredentials | null;
    save(credentials: OAuthCredentials): void;
    delete(vendor: string): boolean;
    updateTokens(vendor: string, accessToken: string, refreshToken: string | null | undefined, expiresIn: number, nowMs?: number): OAuthCredentials | null;
}
