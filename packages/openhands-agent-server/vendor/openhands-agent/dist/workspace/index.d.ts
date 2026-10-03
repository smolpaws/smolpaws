import { type GitChange, type GitDiff } from '../git/index.js';
export type TargetType = 'binary' | 'binary-minimal' | 'source' | 'source-minimal' | 'base-image-minimal' | 'base-image' | 'builder';
export type PlatformType = 'linux/amd64' | 'linux/arm64';
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';
export interface WorkspaceCommandResult {
    readonly command: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timeoutOccurred: boolean;
}
export interface FileOperationResult {
    readonly success: boolean;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly fileSize?: number;
    readonly error?: string;
}
export interface BaseWorkspace {
    readonly workingDir: string;
    executeCommand(command: string, options?: {
        readonly cwd?: string | null;
        readonly timeoutSeconds?: number;
    }): Promise<WorkspaceCommandResult>;
    fileUpload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
    fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
    gitChanges(path: string): Promise<GitChange[]>;
    gitDiff(path: string): Promise<GitDiff>;
    pause(): Promise<void>;
    resume(): Promise<void>;
}
export interface LocalWorkspaceOptions {
    readonly workingDir?: string;
    readonly working_dir?: string;
}
export declare class LocalWorkspace implements BaseWorkspace {
    readonly workingDir: string;
    constructor(options?: LocalWorkspaceOptions);
    executeCommand(command: string, options?: {
        readonly cwd?: string | null;
        readonly timeoutSeconds?: number;
    }): Promise<WorkspaceCommandResult>;
    fileUpload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
    fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
    gitChanges(path: string): Promise<GitChange[]>;
    gitDiff(path: string): Promise<GitDiff>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    private copy;
    private resolvePath;
}
export interface RemoteWorkspaceOptions extends LocalWorkspaceOptions {
    readonly host: string;
    readonly apiKey?: string | null;
    readonly api_key?: string | null;
    readonly readTimeoutSeconds?: number;
    readonly read_timeout?: number;
    readonly runtimeConversationId?: string | null;
    readonly runtime_conversation_id?: string | null;
}
export declare class RemoteWorkspace implements BaseWorkspace {
    readonly host: string;
    readonly apiKey: string | null;
    readonly workingDir: string;
    readonly readTimeoutSeconds: number;
    readonly runtimeConversationId: string | null;
    constructor(options: RemoteWorkspaceOptions);
    alive(): Promise<boolean>;
    getServerInfo(): Promise<Record<string, unknown>>;
    executeCommand(command: string, options?: {
        readonly cwd?: string | null;
        readonly timeoutSeconds?: number;
    }): Promise<WorkspaceCommandResult>;
    startCommand(command: string, options?: {
        readonly cwd?: string | null;
        readonly timeoutSeconds?: number;
    }): Promise<string>;
    getCommandOutput(commandId?: string | null): Promise<Record<string, unknown> | null>;
    getRuntimeSessionKey(): Promise<string>;
    releaseRuntime(): Promise<void>;
    fileUpload(sourcePath: string | Uint8Array, destinationPath: string): Promise<FileOperationResult>;
    fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
    gitChanges(path: string): Promise<GitChange[]>;
    gitDiff(path: string): Promise<GitDiff>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    private get apiPrefix();
    private requireRuntimeScope;
    private parseCommandId;
    private request;
}
export interface WorkspaceOptions extends LocalWorkspaceOptions {
    readonly host?: string | null;
    readonly apiKey?: string | null;
    readonly api_key?: string | null;
    readonly readTimeoutSeconds?: number;
    readonly read_timeout?: number;
    readonly runtimeConversationId?: string | null;
    readonly runtime_conversation_id?: string | null;
}
export declare function workspace(options?: WorkspaceOptions): BaseWorkspace;
export interface RepoSourceOptions {
    readonly url: string;
    readonly ref?: string | null;
    readonly provider?: GitProvider | null;
}
export declare class RepoSource {
    readonly url: string;
    readonly ref: string | null;
    readonly provider: GitProvider | null;
    constructor(options: string | RepoSourceOptions);
    getProvider(): GitProvider;
    getTokenName(): string;
}
export interface RepoMapping {
    readonly url: string;
    readonly dirName: string;
    readonly localPath: string;
    readonly ref?: string | null;
}
export interface CloneResult {
    readonly successCount: number;
    readonly failedRepos: readonly string[];
    readonly repoMappings: Readonly<Record<string, RepoMapping>>;
}
export declare function buildCloneUrl(url: string, provider: GitProvider, token?: string | null, explicitProvider?: boolean): string;
export declare function getReposContext(repoMappings: Readonly<Record<string, RepoMapping>>): string;
