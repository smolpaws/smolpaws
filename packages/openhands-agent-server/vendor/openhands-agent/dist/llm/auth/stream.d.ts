import type { AttemptDeadline } from '../request-deadlines.js';
import type { FetchResponseLike } from '../client.js';
/** Codex requires SSE even when callers want one completed SDK response. */
export declare function readSubscriptionResponse(response: FetchResponseLike, onTerminalResponse?: (response: unknown) => void, deadline?: AttemptDeadline): Promise<unknown>;
