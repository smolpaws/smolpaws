/** Provider-agnostic LLM error classification for recovery control flow.

Background: upstream `software-agent-sdk` distinguishes content-policy blocks
from generic bad requests so the sequential/reasoning agent loop can recover
softly (emit a user nudge and continue) instead of hard-erroring. A content-policy
block is deterministic for a fixed (messages, model): a bare retry trips the same
filter, so recovery requires changing the request, not re-sending it.

In this transpilation no LiteLLM exception layer exists; provider clients own
their error mapping. This module supplies the shared classification predicate and
exception type that provider clients raise and the agent loop catches.
 */
export declare class LLMBadRequestError extends Error {
    constructor(message?: string);
}
export declare class LLMContextWindowExceedError extends LLMBadRequestError {
    constructor(message?: string);
}
export declare class LLMMalformedConversationHistoryError extends LLMBadRequestError {
    constructor(message?: string);
}
export declare class LLMContentPolicyViolationError extends LLMBadRequestError {
    constructor(message?: string);
}
/** True when the provider blocked the request/response via its content filter. */
export declare function isContentPolicyViolation(error: unknown): boolean;
/** Includes the typed cause retained by LLMResponseError for failed paid responses. */
export declare function isContextWindowExceeded(error: unknown): boolean;
export declare function looksLikeMalformedConversationHistoryError(error: unknown): boolean;
/** Called only at a provider ingress, never over arbitrary conversation text.
 * No response body is retained in the error (subscription failures may echo input).
 */
export declare function providerResponseError(provider: string, status: number, body: unknown): Error;
/** Support typed transport wrappers used by advanced/injected provider clients. */
export declare function mapProviderException(error: unknown): unknown;
