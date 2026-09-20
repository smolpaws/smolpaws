import { materializeCondenser, validateAgentSettings, type Condenser, type CondenserSettings, type LLMClient, type LLMProfile, type OpenHandsAgentSettings } from '@smolpaws/openhands-agent';

import type { AgentFactoryContext } from './eventService.js';
import { condenserBindingSchema, type CondenserBinding } from './models.js';
import type { ProfileSelectionResolver } from './profileRuntime.js';

interface BindingOptions {
  readonly agentSettings: OpenHandsAgentSettings;
  readonly getProfile: (name: string) => Promise<LLMProfile | null>;
  readonly createClient: (profile: LLMProfile) => Promise<LLMClient>;
  readonly resolveProfileSelection?: ProfileSelectionResolver;
}

/** Capture once before the first completion; catalog/configuration edits cannot rewrite this binding. */
export async function materializeProfileCondenser(
  settings: CondenserSettings,
  agentLlm: LLMClient,
  context: AgentFactoryContext,
  options: BindingOptions,
): Promise<Condenser | null> {
  if (!settings.enabled || settings.condenser_kind === 'no_op' || settings.condenser_kind === 'agent_reset') {
    return materializeCondenser(settings, { resolveClient: () => { throw new Error('Profile-free condenser must not resolve a client'); } });
  }
  let binding: CondenserBinding | undefined = context.stored.request.condenser_binding;
  if (binding === undefined) {
    if (context.updateRequest === undefined) throw new Error('condenser_profile_persistence_required');
    const settingsKey = JSON.stringify(settings);
    const requestAgentKey = JSON.stringify(context.stored.request.agent);
    const mainSnapshotKey = JSON.stringify(context.stored.request.llm_profile_snapshot);
    const reference = settings.llm_profile_ref ?? await options.resolveProfileSelection?.(context);
    if (reference === undefined) throw new Error('condenser_profile_required: set agent.condenser.llm_profile_ref or configure the condenser role');
    const profile = await options.getProfile(reference);
    if (profile === null) throw new Error(`condenser_profile_not_found:${reference}`);
    let maxTokens = settings.max_tokens;
    if (maxTokens === undefined) {
      await agentLlm.resolveRuntimeMetadata?.();
      maxTokens = agentLlm.effectiveMaxInputTokens ?? null;
    }
    const candidate = condenserBindingSchema.parse({ profile: structuredClone(profile), settings: { ...settings, llm_profile_ref: reference, max_tokens: maxTokens } });
    // Resolve metadata outside the lease lock. The guarded synchronous recheck is
    // the only publication point; no provider/client work happens while it is held.
    await context.updateRequest(request => {
      if (request.condenser_binding !== undefined) return request;
      const current = validateAgentSettings(request.agent ?? options.agentSettings);
      if (JSON.stringify(request.agent) !== requestAgentKey
        || current.agent_kind !== 'openhands' || JSON.stringify(current.condenser) !== settingsKey
        || JSON.stringify(request.llm_profile_snapshot) !== mainSnapshotKey) {
        throw new Error('condenser_configuration_changed_during_capture');
      }
      // Legacy metadata can omit agent settings. Pin the already-selected server
      // fallback atomically with the binding so later defaults cannot rewrite it.
      return { ...request, ...((request.agent === undefined || request.agent === null) ? { agent: structuredClone(options.agentSettings) } : {}), condenser_binding: candidate };
    });
    binding = context.stored.request.condenser_binding;
    if (binding === undefined) throw new Error('condenser_profile_persistence_failed');
  }
  const captured = condenserBindingSchema.parse(structuredClone(binding));
  return materializeCondenser(captured.settings, {
    agentLlm,
    resolveClient: async reference => {
      if (reference !== captured.profile.profileId) throw new Error('condenser_profile_snapshot_mismatch');
      return options.createClient(captured.profile);
    },
  });
}
