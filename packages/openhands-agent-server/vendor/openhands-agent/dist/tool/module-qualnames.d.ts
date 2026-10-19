/**
 * Verified Python definition modules for the corresponding native tools.
 * These are protocol provenance, never dynamic imports or capability claims.
 * Hosts must explicitly attach a value to the actual implementation they register;
 * matching a registration's name alone does not establish this provenance.
 */
export declare const NATIVE_TOOL_MODULE_QUALNAMES: Readonly<{
    readonly terminal: "openhands.tools.terminal.definition";
    readonly file_editor: "openhands.tools.file_editor.definition";
    readonly task_tracker: "openhands.tools.task_tracker.definition";
    readonly glob: "openhands.tools.glob.definition";
    readonly grep: "openhands.tools.grep.definition";
    readonly finish: "openhands.sdk.tool.builtins.finish";
    readonly think: "openhands.sdk.tool.builtins.think";
    readonly switch_llm: "openhands.sdk.tool.builtins.switch_llm";
    readonly route_task_to_model: "openhands.sdk.tool.builtins.classify_and_switch_llm";
}>;
