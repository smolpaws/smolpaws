export type EnvLike = Readonly<Record<string, string | undefined>>;
export type SpanType = 'DEFAULT' | 'LLM' | 'TOOL';
export interface ObserveOptions {
    readonly name?: string | null;
    readonly sessionId?: string | null;
    readonly userId?: string | null;
    readonly ignoreInput?: boolean;
    readonly ignoreOutput?: boolean;
    readonly spanType?: SpanType;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly tags?: readonly string[] | null;
    readonly env?: EnvLike;
    readonly adapter?: ObserveAdapter;
}
export interface ObserveAdapter {
    observe<Args extends unknown[], Result>(options: ObserveOptions, fn: (...args: Args) => Result): (...args: Args) => Result;
}
export interface LaminarInitOptions {
    readonly env?: EnvLike;
    readonly initializer?: () => void;
    readonly isInitialized?: () => boolean;
}
export interface RootSpanOptions {
    readonly sessionId?: string | null;
    readonly userId?: string | null;
    readonly attributes?: Readonly<Record<string, string>> | null;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly tags?: readonly string[] | null;
    readonly env?: EnvLike;
    readonly spanFactory?: (name: string, options: RootSpanOptions) => RootSpanHandle;
}
export interface RootSpanHandle {
    readonly setAttribute?: (key: string, value: string) => void;
    readonly beginChild?: (name: string, tags?: readonly string[] | null) => void;
    readonly end?: () => void;
}
export declare class RootSpan {
    readonly handle: RootSpanHandle;
    private ended;
    constructor(handle: RootSpanHandle);
    end(): void;
}
export declare const observabilityEnvKeys: readonly ["LMNR_PROJECT_API_KEY", "OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"];
export declare function getEnv(key: string, env?: EnvLike): string | undefined;
export declare function shouldEnableObservability(env?: EnvLike): boolean;
export declare function maybeInitLaminar(options?: LaminarInitOptions): boolean;
export declare function observe(options?: ObserveOptions): <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result;
export declare function startRootSpan(name: string, options?: RootSpanOptions): RootSpan | null;
export declare function endRootSpan(root: RootSpan | null | undefined): void;
export declare function startChildSpan(root: RootSpan | null | undefined, name: string, tags?: readonly string[] | null): void;
export declare function extractActionName(actionEvent: unknown): string;
