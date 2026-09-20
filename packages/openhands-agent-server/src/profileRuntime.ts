import { Agent, ensureLlmHistoryOrigin, llmProfileSchema, redactTextSecrets, validateAgentSettings, type ConversationState, type LLMClient, type LLMProfile } from '@smolpaws/openhands-agent';

import type { AgentFactoryContext } from './eventService.js';
import type { StartConversationRequest, StoredConversation } from './models.js';

/** Host-owned selection, evaluated only when a caller requests conversation work. */
export type ProfileSelectionResolver = (context: AgentFactoryContext) => string | undefined | Promise<string | undefined>;

export interface ProfileRuntimeOptions {
  readonly getProfile: (name: string) => Promise<LLMProfile | null>;
  readonly createClient: (profile: LLMProfile) => Promise<LLMClient>;
  readonly resolveProfileSelection?: ProfileSelectionResolver;
}

export type UpdateConversationRequest = (update: (request: StartConversationRequest) => StartConversationRequest) => Promise<void>;

/** Pending choices are durable; only the SDK's quiescent boundary activates them. */
export class ConversationProfileRuntime {
  private mutationTail: Promise<void> = Promise.resolve();
  private prepared: { readonly profile: LLMProfile; readonly client: LLMClient } | undefined;

  constructor(
    private readonly stored: StoredConversation,
    private readonly options: ProfileRuntimeOptions,
    private readonly updateRequest: UpdateConversationRequest,
  ) {}

  async observeConfiguration(): Promise<void> {
    if (this.options.resolveProfileSelection === undefined) return;
    await this.serialize(async () => {
      const selected = await this.options.resolveProfileSelection!({ stored: this.stored });
      const configuredRef = selected ?? null;
      if (this.stored.request.llm_profile_selection?.configured_ref === configuredRef) return;
      const current = validateAgentSettings(this.stored.request.agent);
      if (current.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
      if (selected === undefined || selected === current.llm_profile_ref) {
        await this.updateRequest((request) => ({ ...request, llm_profile_selection: {
          configured_ref: configuredRef,
          pending_profile: selected === undefined ? request.llm_profile_selection?.pending_profile ?? null : null,
        } }));
        if (selected !== undefined) this.prepared = undefined;
      } else {
        await this.prepare(selected, configuredRef);
      }
    });
  }

  async switchProfile(name: string): Promise<{ model: string }> {
    try {
      return await this.serialize(async () => ({ model: (await this.prepare(name)).model }));
    } catch (error) {
      // Tool errors become durable observations; never forward arbitrary request/cause objects.
      throw new Error(error instanceof Error ? redactTextSecrets(error.message)
        .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/giu, '$1 <redacted>') : 'Profile selection failed.');
    }
  }

  async activate(agent: Agent): Promise<Agent | void> {
    return this.serialize(async () => {
      const next = await this.pendingClient();
      if (next === undefined) return;
      const { profile, client } = next;
      // Preserve every non-LLM component, including tool instances and host context.
      const replacement = new Agent({ llm: client, tools: agent.tools, context: agent.context,
        condenser: agent.condenser, hardCondenser: agent.hardCondenser, systemPrompt: agent.systemPrompt, toolConcurrencyLimit: agent.toolConcurrencyLimit,
        ...(agent.usageId === undefined ? {} : { usageId: agent.usageId }),
      });
      await this.commit(profile);
      return replacement;
    });
  }

  /** The first/restored binding may be superseded before its credentials are needed. */
  async prepareInitial(state: ConversationState): Promise<LLMClient | undefined> {
    return this.serialize(async () => {
      const next = await this.pendingClient();
      if (next === undefined) return;
      const settings = validateAgentSettings(this.stored.request.agent);
      if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
      const original = this.stored.request.llm_profile_snapshot ?? await this.options.getProfile(settings.llm_profile_ref);
      if (original === null) throw new Error(`llm_profile_not_found:${settings.llm_profile_ref}`);
      // Persist old-history provenance before changing the snapshot; no old client is constructed.
      await ensureLlmHistoryOrigin(state, original);
      await this.commit(next.profile);
      return next.client;
    });
  }

  private async pendingClient(): Promise<{ profile: LLMProfile; client: LLMClient } | undefined> {
    const pending = this.stored.request.llm_profile_selection?.pending_profile;
    if (pending === undefined || pending === null) return;
    const profile = llmProfileSchema.parse(pending);
    const client = this.prepared !== undefined && JSON.stringify(this.prepared.profile) === JSON.stringify(profile)
      ? this.prepared.client : await this.options.createClient(profile);
    return { profile, client };
  }

  private async commit(profile: LLMProfile): Promise<void> {
    await this.updateRequest((request) => ({ ...request,
      agent: { ...validateAgentSettings(request.agent), llm_profile_ref: profile.profileId },
      llm_profile_snapshot: profile,
      llm_profile_selection: { configured_ref: request.llm_profile_selection?.configured_ref ?? null, pending_profile: null },
    }));
    this.prepared = undefined;
  }

  private async prepare(name: string, configuredRef?: string | null): Promise<LLMProfile> {
    const found = await this.options.getProfile(name);
    if (found === null) throw new Error(`llm_profile_not_found:${name}`);
    const profile = llmProfileSchema.parse(structuredClone(found));
    const client = await this.options.createClient(profile);
    // Do not wait for the run here: this function can be called by a tool inside that run.
    await this.updateRequest((request) => ({ ...request, llm_profile_selection: {
      configured_ref: configuredRef === undefined ? request.llm_profile_selection?.configured_ref ?? null : configuredRef,
      pending_profile: profile,
    } }));
    this.prepared = { profile, client };
    return profile;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
