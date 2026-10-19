import { type GitChange, type GitDiff } from '../git/index.js';
import { AgentContext } from '../context/agent-context.js';
import { type Skill } from '../skills/index.js';
import { type ObservabilityRuntime } from '../observability/index.js';
import { type CompletionCallbackRuntime } from './completion-callback.js';
export type { CompletionCallbackRuntime, WorkspaceCompletionRegistration } from './completion-callback.js';
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
    readonly completionCallback?: CompletionCallbackRuntime;
    readonly observability?: ObservabilityRuntime;
    readonly workingDir?: string;
    readonly working_dir?: string;
}
export declare class LocalWorkspace implements BaseWorkspace {
    readonly workingDir: string;
    private readonly completion;
    constructor(options?: LocalWorkspaceOptions);
    registerConversation(id: string): void;
    registerCost(cost: number | null): void;
    get accumulatedCost(): number | null;
    close(error?: unknown): Promise<void>;
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
export interface RemoteSkillLoadOptions {
    readonly projectDirs?: readonly string[];
    readonly loadPublic?: boolean;
    readonly loadUser?: boolean;
    readonly loadProject?: boolean;
    readonly loadOrg?: boolean;
    readonly timeoutSeconds?: number;
    readonly baseContext?: AgentContext | null;
}
export declare class RemoteWorkspace implements BaseWorkspace {
    private readonly completion;
    private readonly observability;
    readonly host: string;
    readonly apiKey: string | null;
    readonly workingDir: string;
    readonly readTimeoutSeconds: number;
    readonly runtimeConversationId: string | null;
    constructor(options: RemoteWorkspaceOptions);
    registerConversation(id: string): void;
    registerCost(cost: number | null): void;
    get accumulatedCost(): number | null;
    close(error?: unknown): Promise<void>;
    alive(): Promise<boolean>;
    getServerInfo(): Promise<Record<string, unknown>>;
    /**
     * Load server skills, replacing the base context's skills while preserving its
     * other fields and applying its disabledSkills deny-list. Later project
     * directories override earlier skills with the same name.
     *
     * Local automatic public/user discovery is not implemented. When the server
     * returns no usable skills (including on failure), retain the supplied context's
     * explicit skills instead of Python's automatic public-skill fallback.
     */
    loadSkillsFromAgentServer(options?: RemoteSkillLoadOptions): Promise<[Skill[], AgentContext]>;
    private callSkillsApi;
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
    /** Stop only this managed command; already-finished and unknown IDs are no-ops. */
    stopCommand(commandId: string): Promise<void>;
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
