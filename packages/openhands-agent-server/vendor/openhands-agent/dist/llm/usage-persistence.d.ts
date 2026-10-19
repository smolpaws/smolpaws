/** A paid completion must not be retried merely because its usage could not be saved. */
export declare class LLMUsagePersistenceError extends Error {
    constructor(cause: unknown);
}
