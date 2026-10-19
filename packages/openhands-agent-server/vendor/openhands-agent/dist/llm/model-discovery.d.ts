export { MODEL_DISCOVERY_PROVENANCE } from './model-discovery-catalog.js';
export interface SupportedLLMModelsOptions {
    readonly modelIds?: readonly string[];
    readonly modelCostIds?: readonly string[];
    /** Results from an actual host-owned authenticated AWS discovery adapter. */
    readonly bedrockModelIds?: readonly string[];
}
/** Offline catalog membership, not a claim of endpoint access or model metadata.
 * Hosts own live AWS discovery; no credentials or provider calls occur here.
 */
export declare function getSupportedLLMModels(options?: SupportedLLMModelsOptions): string[];
