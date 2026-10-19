import { type ConversationObservabilityOptions, type EnvLike, type HeaderInjector } from '../observability/index.js';
export interface AutomationContextOptions {
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly tags?: readonly string[] | null;
    readonly spanName?: string | null;
    readonly parentSpanContext?: string | null;
    readonly env?: EnvLike;
    readonly injectHeaders?: HeaderInjector;
}
export type AutomationObservabilityContext = Pick<ConversationObservabilityOptions, 'observabilityMetadata' | 'observabilityTags' | 'observabilitySpanName' | 'observabilityParentSpanContext'>;
export declare function automationObservabilityContext(options?: AutomationContextOptions): AutomationObservabilityContext;
export declare function automationConversationTags(metadata?: Readonly<Record<string, unknown>> | null, env?: EnvLike): Record<string, string>;
export interface AutomationConversationOptions extends Omit<AutomationContextOptions, 'tags'> {
    readonly observabilityTags?: readonly string[] | null;
    readonly conversationTags?: Readonly<Record<string, string>> | null;
    readonly includeConversationTags?: boolean;
}
/** Native constructor options equivalent to Python automation_conversation_kwargs. */
export declare function automationConversationOptions(options?: AutomationConversationOptions): AutomationObservabilityContext & {
    readonly tags?: Readonly<Record<string, string>>;
};
export declare const automationConversationKwargs: typeof automationConversationOptions;
export declare function automationObservabilityHeaders(options?: AutomationContextOptions): Record<string, string>;
