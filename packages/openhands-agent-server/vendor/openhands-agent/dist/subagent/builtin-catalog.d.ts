import type { AgentDefinitionOptions } from './index.js';
export declare const builtinAgentSource: {
    readonly repository: "OpenHands/software-agent-sdk";
    readonly commit: "5fa4dea24c52fe3ac53fa4e3e67a1376b72189e2";
    readonly factory: "openhands-tools/openhands/tools/preset/default.py::discover_builtin_agents";
    readonly files: {
        readonly "openhands-tools/openhands/tools/preset/subagents/bash_runner.md": "6485915175e28dadc1371d68448a6371e353491896a4ef5eea0422425f12444c";
        readonly "openhands-tools/openhands/tools/preset/subagents/code_explorer.md": "ff947caf38dbfe1bfd2d6ff1973ba798f8a34fbfd29cf213d624acc0603924d8";
        readonly "openhands-tools/openhands/tools/preset/subagents/default.md": "e8355f405c62305e3cea6d1853bbb8dce867b94b594d04ab07c25484e6f8807e";
        readonly "openhands-tools/openhands/tools/preset/subagents/web_researcher.md": "f2438787336621cc11e0c234c0a6be2b8f579cfeb66046fb9be4afcd7ed4e4df";
    };
};
export declare const builtinAgentCatalog: readonly AgentDefinitionOptions[];
