export interface CachedGitOptions {
    readonly ref: string | null;
    readonly update: boolean;
    readonly strict?: boolean;
}
export declare function isCachedGitPinned(directory: string): Promise<boolean>;
/** For disposable SDK cache directories only: branch updates reset cached files. */
export declare function cachedGitFetcher(url: string, destination: string, options: CachedGitOptions): Promise<string>;
