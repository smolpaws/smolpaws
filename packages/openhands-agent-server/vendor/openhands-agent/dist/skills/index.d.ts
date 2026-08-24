import { z } from 'zod';
export declare const keywordTriggerSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"keyword">>;
    keywords: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const taskTriggerSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"task">>;
    triggers: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const pathTriggerSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"path">>;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const triggerSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"keyword">>;
    keywords: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"task">>;
    triggers: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"path">>;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>], "type">;
export declare const inputMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
}, z.core.$strict>;
export declare const skillResourcesSchema: z.ZodObject<{
    skillRoot: z.ZodString;
    scripts: z.ZodDefault<z.ZodArray<z.ZodString>>;
    references: z.ZodDefault<z.ZodArray<z.ZodString>>;
    assets: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
declare const skillDataSchema: z.ZodObject<{
    name: z.ZodString;
    content: z.ZodString;
    trigger: z.ZodDefault<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"keyword">>;
        keywords: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"task">>;
        triggers: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"path">>;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">>>;
    source: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    mcpTools: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    inputs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
    isAgentskillsFormat: z.ZodDefault<z.ZodBoolean>;
    version: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    license: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    compatibility: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    metadata: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
    allowedTools: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
    disableModelInvocation: z.ZodDefault<z.ZodBoolean>;
    resources: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        skillRoot: z.ZodString;
        scripts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        references: z.ZodDefault<z.ZodArray<z.ZodString>>;
        assets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type KeywordTrigger = z.infer<typeof keywordTriggerSchema>;
export type TaskTrigger = z.infer<typeof taskTriggerSchema>;
export type PathTrigger = z.infer<typeof pathTriggerSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type InputMetadata = z.infer<typeof inputMetadataSchema>;
export type SkillResources = z.infer<typeof skillResourcesSchema>;
export type SkillData = z.infer<typeof skillDataSchema>;
export type SkillType = 'repo' | 'knowledge' | 'agentskills';
export declare class Skill implements SkillData {
    readonly name: string;
    readonly content: string;
    readonly trigger: Trigger | null;
    readonly source: string | null;
    readonly mcpTools: Record<string, unknown> | null;
    readonly inputs: InputMetadata[];
    readonly isAgentskillsFormat: boolean;
    readonly version: string;
    readonly description: string | null;
    readonly license: string | null;
    readonly compatibility: string | null;
    readonly metadata: Record<string, string> | null;
    readonly allowedTools: string[] | null;
    readonly disableModelInvocation: boolean;
    readonly resources: SkillResources | null;
    constructor(data: SkillData);
    static load(path: string, skillBaseDir?: string, strict?: boolean): Promise<Skill>;
    matchTrigger(message: string): string | null;
    getTriggers(): string[];
    matchPathTrigger(filePath: string): string | null;
    getSkillType(): SkillType;
    requiresUserInput(): boolean;
}
export declare const skillSchema: z.ZodPipe<z.ZodObject<{
    name: z.ZodString;
    content: z.ZodString;
    trigger: z.ZodDefault<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"keyword">>;
        keywords: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"task">>;
        triggers: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"path">>;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">>>;
    source: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    mcpTools: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    inputs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
    }, z.core.$strict>>>;
    isAgentskillsFormat: z.ZodDefault<z.ZodBoolean>;
    version: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    license: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    compatibility: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    metadata: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
    allowedTools: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
    disableModelInvocation: z.ZodDefault<z.ZodBoolean>;
    resources: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        skillRoot: z.ZodString;
        scripts: z.ZodDefault<z.ZodArray<z.ZodString>>;
        references: z.ZodDefault<z.ZodArray<z.ZodString>>;
        assets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<Skill, {
    name: string;
    content: string;
    trigger: {
        type: "keyword";
        keywords: string[];
    } | {
        type: "task";
        triggers: string[];
    } | {
        type: "path";
        paths: string[];
    } | null;
    source: string | null;
    mcpTools: Record<string, unknown> | null;
    inputs: {
        name: string;
        description: string;
    }[];
    isAgentskillsFormat: boolean;
    version: string;
    description: string | null;
    license: string | null;
    compatibility: string | null;
    metadata: Record<string, string> | null;
    allowedTools: string[] | null;
    disableModelInvocation: boolean;
    resources: {
        skillRoot: string;
        scripts: string[];
        references: string[];
        assets: string[];
    } | null;
}>>;
export interface LoadedSkills {
    readonly repoSkills: Record<string, Skill>;
    readonly knowledgeSkills: Record<string, Skill>;
    readonly agentSkills: Record<string, Skill>;
}
export declare function loadSkillsFromDir(skillDir: string): Promise<LoadedSkills>;
export declare function mergeSkillsByName(primary: readonly Skill[], secondary: readonly Skill[]): Skill[];
export declare function skillsToPrompt(skills: readonly Skill[], maxDescriptionLength?: number): string;
export declare function pathMatchesGlob(filePath: string, pattern: string): boolean;
export {};
