export type AgentDefinitionLevel = 'project' | 'user' | 'builtin' | 'plugin' | 'programmatic';
export interface AgentDefinitionOptions {
    readonly name: string;
    readonly description?: string;
    readonly model?: string;
    readonly color?: string | null;
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    readonly system_prompt?: string;
    readonly source?: string | null;
    readonly when_to_use_examples?: readonly string[];
    readonly hooks?: unknown;
    readonly max_iteration_per_run?: number | null;
    readonly max_budget_per_run?: number | null;
    readonly mcp_servers?: Record<string, unknown> | null;
    readonly mcp_config?: Record<string, unknown> | null;
    /** Metadata only; native confirmation execution remains disabled. */
    readonly permission_mode?: string | null;
    readonly profile_store_dir?: string | null;
    readonly condenser?: unknown;
    readonly metadata?: Record<string, unknown>;
    readonly level?: AgentDefinitionLevel | null;
}
export declare class AgentDefinition {
    readonly name: string;
    readonly description: string;
    readonly model: string;
    readonly color: string | null;
    readonly tools: string[];
    readonly skills: string[];
    readonly system_prompt: string;
    readonly source: string | null;
    readonly when_to_use_examples: string[];
    readonly hooks: unknown;
    readonly max_iteration_per_run: number | null;
    readonly max_budget_per_run: number | null;
    readonly mcp_config: Record<string, unknown> | null;
    readonly permission_mode: string | null;
    readonly profile_store_dir: string | null;
    readonly condenser: unknown;
    readonly metadata: Record<string, unknown>;
    readonly level: AgentDefinitionLevel | null;
    constructor(options: AgentDefinitionOptions);
    /** Deprecated read alias; canonical JSON carries mcp_config only. */
    get mcp_servers(): Record<string, unknown> | null;
    static load(agentPath: string): Promise<AgentDefinition>;
}
export declare function loadProjectAgents(projectDir: string): Promise<AgentDefinition[]>;
export declare function loadUserAgents(): Promise<AgentDefinition[]>;
export interface DiscoverAgentsOptions {
    readonly projectDir?: string | null;
    readonly includeProject?: boolean;
    readonly includeUser?: boolean;
}
export declare function discoverAgents(options?: DiscoverAgentsOptions): Promise<AgentDefinition[]>;
export declare function loadAgentsFromDirs(directories: readonly string[]): Promise<AgentDefinition[]>;
export declare function loadAgentsFromDir(agentsDir: string): Promise<AgentDefinition[]>;
export type AgentFactoryFunction = (llm: unknown) => unknown;
export interface AgentFactory {
    readonly factoryFunc: AgentFactoryFunction;
    readonly definition: AgentDefinition;
}
export declare function registerAgent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): void;
export declare function registerAgentIfAbsent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): boolean;
export declare function getAgentFactory(name: string | null | undefined): AgentFactory;
export declare function getFactoryInfo(include?: (definition: AgentDefinition) => boolean): string;
export declare function getRegisteredAgentDefinitions(): AgentDefinition[];
export declare function resetAgentRegistryForTests(): void;
