/**
 * Canonical default tool names for the standard OpenHands agent.
 *
 * Tool *names* are a wire contract: they are persisted in settings/profile JSON
 * and sent by clients, independently of where the implementations live. The
 * TypeScript SDK owns the same default names as upstream
 * ``openhands.sdk.tool.defaults`` so a bare ``tools: null`` settings value can
 * resolve to the same deterministic exec set without importing the concrete
 * tool implementations (environment-dependent tools are injected by the serving
 * layer, not by this default).
 */
export declare const DEFAULT_EXEC_TOOL_NAMES: readonly ["terminal", "file_editor", "task_tracker"];
/** Name of the browser tool set; a serving-layer injection, not a default. */
export declare const BROWSER_TOOL_NAME = "browser_tool_set";
/** Name of the sub-agent delegation tool set, gated on ``enable_sub_agents``. */
export declare const SUB_AGENT_TOOL_NAME = "task_tool_set";
export interface DefaultToolSpecOptions {
    readonly enableSubAgents?: boolean;
    readonly enableBrowser?: boolean;
}
export declare function defaultToolSpecs(options?: DefaultToolSpecOptions): string[];
