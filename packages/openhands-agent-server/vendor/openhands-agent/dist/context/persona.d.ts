import type { ToolDefinition } from '../tool/index.js';
export interface StaticSystemPromptOptions {
    readonly systemPrompt?: string | null;
    readonly persona?: string | null;
    readonly tools?: readonly ToolDefinition[];
    readonly model?: string;
    readonly preset?: 'default' | 'planning';
    readonly planStructure?: string;
}
export declare function toolPromptGuidance(tools: readonly ToolDefinition[]): string[];
export declare function renderStaticSystemPrompt(options?: StaticSystemPromptOptions): string;
