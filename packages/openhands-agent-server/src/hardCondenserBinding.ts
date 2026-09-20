import {
  materializeHardCondenser, validateAgentSettings,
  type HardCondenserSettings, type LLMClient, type LLMProfile,
  type LLMSummarizingCondenser, type OpenHandsAgentSettings,
} from '@smolpaws/openhands-agent';

import type { AgentFactoryContext } from './eventService.js';
import { hardCondenserBindingSchema, type HardCondenserBinding } from './models.js';

interface HardBindingOptions {
  readonly agentSettings: OpenHandsAgentSettings;
  readonly getProfile: (name: string) => Promise<LLMProfile | null>;
  readonly createClient: (profile: LLMProfile) => Promise<LLMClient>;
}

/** Persist the explicit independent fallback before constructing its client. */
export async function materializeProfileHardCondenser(
  settings: HardCondenserSettings | null | undefined,
  context: AgentFactoryContext,
  options: HardBindingOptions,
): Promise<LLMSummarizingCondenser | null> {
  if (settings === undefined || settings === null) return null;
  let binding: HardCondenserBinding | undefined = context.stored.request.hard_condenser_binding;
  if (binding === undefined) {
    if (context.updateRequest === undefined) throw new Error('hard_condenser_profile_persistence_required');
    const settingsKey = JSON.stringify(settings);
    const requestAgentKey = JSON.stringify(context.stored.request.agent);
    const mainSnapshotKey = JSON.stringify(context.stored.request.llm_profile_snapshot);
    const profile = await options.getProfile(settings.llm_profile_ref);
    if (profile === null) throw new Error(`hard_condenser_profile_not_found:${settings.llm_profile_ref}`);
    const candidate = hardCondenserBindingSchema.parse({
      profile: structuredClone(profile), settings: structuredClone(settings),
    });
    // The lease guard only validates/publishes metadata; provider construction and
    // credential preparation occur after the accepted snapshot is durable.
    await context.updateRequest(request => {
      if (request.hard_condenser_binding !== undefined) return request;
      const current = validateAgentSettings(request.agent ?? options.agentSettings);
      if (JSON.stringify(request.agent) !== requestAgentKey
        || current.agent_kind !== 'openhands' || current.condenser.condenser_kind !== 'agent_reset'
        || !current.condenser.enabled || JSON.stringify(current.hard_condenser) !== settingsKey
        || JSON.stringify(request.llm_profile_snapshot) !== mainSnapshotKey) {
        throw new Error('hard_condenser_configuration_changed_during_capture');
      }
      return { ...request,
        ...((request.agent === undefined || request.agent === null) ? { agent: structuredClone(options.agentSettings) } : {}),
        hard_condenser_binding: candidate,
      };
    });
    binding = context.stored.request.hard_condenser_binding;
    if (binding === undefined) throw new Error('hard_condenser_profile_persistence_failed');
  }
  const captured = hardCondenserBindingSchema.parse(structuredClone(binding));
  return materializeHardCondenser(captured.settings, {
    resolveClient: reference => {
      if (reference !== captured.profile.profileId) throw new Error('hard_condenser_profile_snapshot_mismatch');
      return options.createClient(captured.profile);
    },
  });
}
