import { z } from 'zod';
declare const marketplace: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodObject<{
        name: z.ZodString;
        email: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    plugins: z.ZodDefault<z.ZodArray<z.ZodPreprocess<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        version: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        author: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            email: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>]>>>;
        category: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        homepage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        source: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            source: z.ZodString;
            repo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>]>;
        entry_command: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        strict: z.ZodOptional<z.ZodPreprocess<z.ZodBoolean>>;
        commands: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
        agents: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
        hooks: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>;
        mcpServers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        lspServers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>>>>;
        license: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        repository: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        keywords: z.ZodOptional<z.ZodArray<z.ZodString>>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>>;
    skills: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        source: z.ZodString;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        version: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        author: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            email: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>]>>>;
        category: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        homepage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>>;
    metadata: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        version: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type SkillsMarketplace = z.infer<typeof marketplace>;
/** Parse catalog metadata only; source resolution and installation belong to hosts. */
export declare function parseSkillsMarketplace(value: unknown): SkillsMarketplace;
export declare function parseCatalogSkillNames(value: unknown): Set<string>;
export {};
