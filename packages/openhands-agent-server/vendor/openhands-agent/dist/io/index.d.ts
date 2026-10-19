export interface FileStoreLockOptions {
    readonly timeoutSeconds?: number;
    readonly pollIntervalMs?: number;
    /** Defaults to legacy recovery. False never removes another owner's lock;
     * abandoned locks then require cleanup while all writers are stopped. */
    readonly recoverStaleLocks?: boolean;
}
export interface FileStore {
    write(filePath: string, contents: string | Buffer): void;
    read(filePath: string): string;
    list(filePath: string): string[];
    delete(filePath: string): void;
    exists(filePath: string): boolean;
    getAbsolutePath(filePath: string): string;
    /**
     * Acquire a synchronous lock for local persistence writes.
     *
     * Contention waits block the Node.js event loop; prefer lockAsync on hot server paths.
     */
    lock<T>(filePath: string, callback: () => T, options?: FileStoreLockOptions): T;
    /**
     * Acquire a lock without blocking the Node.js event loop while waiting.
     */
    lockAsync<T>(filePath: string, callback: () => T | Promise<T>, options?: FileStoreLockOptions): Promise<T>;
}
export interface MemoryLRUCacheOptions {
    readonly maxMemory: number;
    readonly maxSize: number;
}
export declare class MemoryLRUCache<K, V> {
    readonly maxMemory: number;
    readonly maxSize: number;
    currentMemory: number;
    private readonly entries;
    constructor(options: MemoryLRUCacheOptions);
    get size(): number;
    has(key: K): boolean;
    get(key: K): V | undefined;
    set(key: K, value: V): this;
    delete(key: K): boolean;
    clear(): void;
    keys(): IterableIterator<K>;
    [Symbol.iterator](): IterableIterator<K>;
    private evictIfNeeded;
}
export interface LocalFileStoreOptions {
    readonly cacheLimitSize?: number;
    readonly cacheMemorySize?: number;
}
export declare class LocalFileStore implements FileStore {
    readonly root: string;
    readonly cache: MemoryLRUCache<string, string>;
    private readonly locks;
    constructor(root: string, options?: LocalFileStoreOptions);
    getFullPath(filePath: string): string;
    getAbsolutePath(filePath: string): string;
    write(filePath: string, contents: string | Buffer): void;
    read(filePath: string): string;
    list(filePath: string): string[];
    lock<T>(filePath: string, callback: () => T, options?: FileStoreLockOptions): T;
    lockAsync<T>(filePath: string, callback: () => T | Promise<T>, options?: FileStoreLockOptions): Promise<T>;
    delete(filePath: string): void;
    exists(filePath: string): boolean;
}
export declare class InMemoryFileStore implements FileStore {
    readonly files: MemoryLRUCache<string, string>;
    private readonly instanceId;
    private readonly locks;
    constructor(files?: Readonly<Record<string, string>>, options?: LocalFileStoreOptions);
    write(filePath: string, contents: string | Buffer): void;
    read(filePath: string): string;
    list(filePath: string): string[];
    delete(filePath: string): void;
    exists(filePath: string): boolean;
    lock<T>(filePath: string, callback: () => T, _options?: FileStoreLockOptions): T;
    lockAsync<T>(filePath: string, callback: () => T | Promise<T>, options?: FileStoreLockOptions): Promise<T>;
    getAbsolutePath(filePath: string): string;
}
export declare class ValueError extends Error {
    constructor(message: string);
}
