import { Skill } from './index.js';
export declare const PUBLIC_SKILLS_REPO = "https://github.com/OpenHands/extensions";
export declare const DEFAULT_MARKETPLACE_PATH = "marketplaces/default.json";
type CatalogRepository = {
    readonly path: string;
    readonly pinned: boolean;
};
export interface PublicSkillsOptions {
    readonly repoUrl?: string;
    readonly ref?: string;
    readonly cacheDirectory?: string;
    readonly marketplacePath?: string | null;
    readonly fetchRepository?: (url: string, ref: string, options: {
        readonly strict: boolean;
    }) => Promise<CatalogRepository>;
}
export declare function invalidatePublicSkillsCache(): void;
/** Force an actual update; preserve the working catalog cache on failure. */
export declare function syncPublicSkills(options?: PublicSkillsOptions): Promise<void>;
/** Public catalog load is best-effort; sync is the strict error-reporting boundary. */
export declare function loadPublicSkills(options?: PublicSkillsOptions): Promise<Skill[]>;
export interface UserSkillsOptions {
    readonly directories?: readonly string[];
    readonly installedDirectory?: string;
    /** The owning installed-skill service supplies only enabled entries. */
    readonly loadInstalled?: () => Promise<readonly Skill[]>;
}
export declare function loadUserSkills(options?: UserSkillsOptions): Promise<Skill[]>;
export {};
