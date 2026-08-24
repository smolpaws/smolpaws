export type ExtensionSourceType = 'local' | 'git' | 'github';
export interface ParsedExtensionSource {
    readonly type: ExtensionSourceType;
    readonly url: string;
}
export declare class ExtensionFetchError extends Error {
}
export declare function parseExtensionSource(source: string): ParsedExtensionSource;
export declare function getCachePath(source: string, cacheDir: string): string;
export interface FetchOptions {
    readonly ref?: string | null;
    readonly update?: boolean;
    readonly repoPath?: string | null;
    readonly gitFetcher?: (url: string, destination: string, options: {
        readonly ref: string | null;
        readonly update: boolean;
    }) => Promise<string | null>;
}
export interface FetchResolution {
    readonly path: string;
    readonly resolvedRef: string | null;
}
export declare function fetchWithResolution(source: string, cacheDir: string, options?: FetchOptions): Promise<FetchResolution>;
export declare function fetchExtension(source: string, cacheDir: string, options?: FetchOptions): Promise<string>;
export interface ExtensionProtocol {
    readonly name: string;
    readonly version: string;
    readonly description?: string | null;
}
export interface InstallationInfoOptions {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly enabled?: boolean;
    readonly source: string;
    readonly requestedRef?: string | null;
    readonly resolvedRef?: string | null;
    readonly repoPath?: string | null;
    readonly installedAt?: string;
    readonly installPath: string;
}
export declare class InstallationInfo {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    enabled: boolean;
    readonly source: string;
    readonly requestedRef: string | null;
    readonly resolvedRef: string | null;
    readonly repoPath: string | null;
    readonly installedAt: string;
    readonly installPath: string;
    constructor(options: InstallationInfoOptions);
    static fromExtension(extension: ExtensionProtocol, source: string, installPath: string, options?: {
        readonly requestedRef?: string | null;
        readonly resolvedRef?: string | null;
        readonly repoPath?: string | null;
    }): InstallationInfo;
    toJSON(): InstallationInfoOptions;
}
export interface InstallationMetadataOptions {
    readonly extensions?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
    readonly plugins?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
    readonly skills?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
}
export declare class InstallationMetadata {
    static readonly metadataFilename = ".installed.json";
    readonly extensions: Record<string, InstallationInfo>;
    constructor(options?: InstallationMetadataOptions);
    static metadataPath(installedDir: string): string;
    static loadFromDir(installedDir: string): Promise<InstallationMetadata>;
    saveToDir(installedDir: string): Promise<void>;
    validateTracked(installedDir: string): InstallationInfo[];
    discoverUntracked(installedDir: string, loadFromDir: (extensionDir: string) => Promise<ExtensionProtocol>): Promise<InstallationInfo[]>;
}
export declare function validateExtensionName(name: string): void;
