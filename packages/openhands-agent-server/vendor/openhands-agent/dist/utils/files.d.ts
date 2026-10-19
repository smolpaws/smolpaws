/** Upstream's temporary-file marker, shared by writers and trajectory readers. */
export declare function isTempFile(path: string): boolean;
/** Publish a complete UTF-8 file by replacing it with an owner-only sibling. */
export declare function atomicWriteText(path: string, value: string, mode?: number): void;
