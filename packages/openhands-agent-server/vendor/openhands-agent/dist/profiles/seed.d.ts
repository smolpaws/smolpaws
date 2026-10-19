import type { AgentContextOptions } from '../context/agent-context.js';
import type { AgentSettings } from '../settings/index.js';
import { type AgentProfile } from './index.js';
export declare const SEED_PROFILE_NAME = "default";
export interface SeedProfileOptions {
    readonly name?: string;
    /** Native hosts hold context separately from credential-free persisted settings. */
    readonly context?: Pick<AgentContextOptions, 'disabledSkills' | 'systemMessageSuffix'>;
}
/** Project validated live settings and native context into a secret-free default profile. */
export declare function buildSeedProfile(settings: AgentSettings, activeLlmProfile: string | null, options?: SeedProfileOptions): AgentProfile;
