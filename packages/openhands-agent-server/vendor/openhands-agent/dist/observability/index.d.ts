export type EnvLike = Readonly<Record<string, string | undefined>>;
export type TraceMetadataValue = string | boolean | number | readonly string[] | readonly boolean[] | readonly number[];
export type HeaderInjector = (headers: Record<string, string>) => void;
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
    readonly attributes?: Readonly<Record<string, TraceMetadataValue>> | null;
    readonly parentSpanContext?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly tags?: readonly string[] | null;
    readonly env?: EnvLike;
    readonly spanFactory?: (name: string, options: RootSpanOptions) => RootSpanHandle;
}
export interface RootSpanHandle {
    readonly setAttribute?: (key: string, value: TraceMetadataValue) => void;
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
export interface ObservabilityRuntime {
    readonly env?: EnvLike;
    readonly spanFactory?: RootSpanOptions['spanFactory'];
    /** Optional host OpenTelemetry propagation adapter; no exporter is installed by the SDK. */
    readonly injectHeaders?: HeaderInjector;
}
export interface ConversationObservabilityOptions {
    readonly userId?: string | null;
    readonly observabilityMetadata?: Readonly<Record<string, unknown>> | null;
    readonly observabilityTags?: readonly string[] | null;
    readonly observabilitySpanName?: string | null;
    readonly observabilityParentSpanContext?: string | null;
    readonly tags?: Readonly<Record<string, string>> | null;
    readonly observability?: ObservabilityRuntime | undefined;
}
export declare function cleanTraceMetadata(value: unknown): Record<string, TraceMetadataValue>;
export declare function observabilityMetadataFromEnv(env?: EnvLike): Record<string, TraceMetadataValue>;
export declare function mergeObservabilityMetadata(metadata?: Readonly<Record<string, unknown>> | null, env?: EnvLike): Record<string, unknown>;
export declare function observabilityTagsFromEnv(env?: EnvLike): string[];
export declare function defaultObservabilitySpanNameFromEnv(env?: EnvLike): string | undefined;
export declare function observabilityParentSpanContextFromEnv(env?: EnvLike): string | undefined;
export declare function observabilityHeadersFromEnv(env?: EnvLike, inject?: HeaderInjector): Record<string, string>;
export declare function observabilityHeaders(context: {
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly tags?: readonly string[] | null;
    readonly spanName?: string | null;
    readonly parentSpanContext?: string | null;
}, inject?: HeaderInjector): Record<string, string>;
export declare function resolveConversationObservability(options: ConversationObservabilityOptions): ConversationObservabilityOptions;
export declare function startConversationSpan(sessionId: string, options: ConversationObservabilityOptions): RootSpan | null;
