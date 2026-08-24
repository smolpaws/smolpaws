import { type Message, type TextContent } from '../llm/index.js';
import { type Skill } from '../skills/index.js';
export interface SecretInfo {
    readonly name: string;
    readonly description?: string | null;
}
export interface AgentContextOptions {
    readonly skills?: readonly Skill[];
    readonly disabledSkills?: readonly string[];
    readonly systemMessageSuffix?: string | null;
    readonly userMessageSuffix?: string | null;
    readonly secrets?: Readonly<Record<string, string | {
        readonly description?: string | null;
    }>> | null;
    readonly currentDatetime?: Date | string | null;
}
export interface UserMessageSuffixResult {
    readonly content: TextContent;
    readonly activatedSkills: string[];
}
export interface ToolUseSuffixResult {
    readonly content: TextContent;
    readonly activatedRules: string[];
}
export declare class AgentContext {
    readonly skills: Skill[];
    readonly systemMessageSuffix: string | null;
    readonly userMessageSuffix: string | null;
    readonly secrets: Readonly<Record<string, string | {
        readonly description?: string | null;
    }>> | null;
    readonly currentDatetime: Date | string | null;
    constructor(options?: AgentContextOptions);
    getSecretInfos(additional?: readonly SecretInfo[]): SecretInfo[];
    getFormattedDatetime(): string | null;
    partitionSkills(): {
        repoSkills: Skill[];
        availableSkills: Skill[];
    };
    getSystemMessageSuffix(additionalSecretInfos?: readonly SecretInfo[]): string | null;
    getToolUseSuffix(filePath: string, skipSkillNames?: readonly string[]): ToolUseSuffixResult | null;
    getUserMessageSuffix(message: Message, skipSkillNames?: readonly string[]): UserMessageSuffixResult | null;
}
