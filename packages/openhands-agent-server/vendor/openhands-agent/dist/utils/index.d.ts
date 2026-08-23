import type { Event } from '../event/index.js';
export type AsyncConversationCallback<TEvent = Event> = (event: TEvent) => Promise<void>;
export declare class AsyncCallbackWrapper<TEvent = Event> {
    readonly callback: (event: TEvent) => void;
    private readonly asyncCallback;
    private readonly pending;
    constructor(asyncCallback: AsyncConversationCallback<TEvent>);
    get pendingCount(): number;
    call(event: TEvent): void;
    waitForPending(timeoutMs?: number): Promise<void>;
}
export declare const DEFAULT_TEXT_CONTENT_LIMIT = 50000;
export declare const DEFAULT_TRUNCATE_NOTICE = "<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you.</NOTE>";
export declare const DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST = "<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you. The complete output has been saved to {filePath} - you can use other tools to view the full content (truncated part starts around line {lineNum}).</NOTE>";
export interface MaybeTruncateOptions {
    readonly truncateAfter?: number | null;
    readonly truncateNotice?: string;
    readonly saveDir?: string | null;
    readonly toolPrefix?: string;
}
export declare function maybeTruncate(content: string, options?: MaybeTruncateOptions): string;
export declare function toPosixPath(inputPath: string | {
    toString(): string;
}): string;
export declare function posixPathName(inputPath: string | {
    toString(): string;
}): string;
export declare function isAbsolutePathSource(inputPath: string | {
    toString(): string;
}): boolean;
export declare function isHostAbsolutePath(inputPath: string | {
    toString(): string;
}): boolean;
export declare function isLocalPathSource(source: string): boolean;
export declare function sanitizeOpenHandsMentions(text: string): string;
export interface Page<T> {
    readonly items: readonly T[];
    readonly nextPageId?: string | null;
}
export declare function pageIterator<T, P extends Record<string, unknown>>(searchFunc: (params: P & {
    pageId?: string;
}) => Promise<Page<T>>, params: P): AsyncGenerator<T>;
export declare function sanitizedEnv(env?: Readonly<Record<string, string | undefined>>): Record<string, string>;
export interface ExecuteCommandOptions {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly printOutput?: boolean;
}
export interface CommandResult {
    readonly command: string | readonly string[];
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
export declare function executeCommand(command: string | readonly string[], options?: ExecuteCommandOptions): CommandResult;
export declare const SECRET_KEY_PATTERNS: Set<string>;
export declare const SENSITIVE_URL_PARAMS: Set<string>;
export declare function isSecretKey(key: string): boolean;
export declare function redactUrlCredentials(url: string, options?: {
    readonly preservePlaceholders?: boolean;
}): string;
export declare function redactUrlCredentialsInText(text: string): string;
export declare function redactUrlParams(url: string): string;
export declare function redactTextSecrets(text: string): string;
export declare function utcNow(): Date;
export declare function dumps(value: unknown, space?: number): string;
export declare function loads(text: string): unknown;
export declare function handleDeprecatedModelFields<T>(data: T, deprecatedFields: readonly string[]): T;
export declare function displayJson(value: unknown): string;
