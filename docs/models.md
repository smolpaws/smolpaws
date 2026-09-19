# Model selection

SmolPaws selects saved LLM profiles by name. The profile owns the provider, model,
API options and secret references. The product configuration only chooses which
profile a role uses.

Put selections in `~/.smolpaws/models.json` (or set `SMOLPAWS_MODELS_CONFIG` on the
product server). `SMOLPAWS_HOME_DIR` changes the default directory. For example,
using profiles already saved on that server:

```json
{
  "version": 1,
  "scopes": {
    "whatsapp:main": { "agent": "eval-fable-5-1" },
    "whatsapp:openhands": { "agent": "deepseek-v4-flash" },
    "whatsapp:hunting": { "agent": "deepseek-v4-flash" }
  }
}
```

`scopes` uses the registered bridge platform and scope ID, joined by `:`. For
WhatsApp, the scope ID is the group's configured folder. Slack and other relay
bridges use their registered scope IDs. Scheduled runs keep their originating
scope, including isolated runs. Incoming message tags cannot select another
channel's configuration.

An explicitly configured isolated task can select its own saved profile through
[`scheduled-agents.json`](scheduled-agents.md). That task selection takes precedence
over the scope's `agent` selection. It also provides the helper's exact tools and
context files; it does not change the owner channel's conversation or profile.

An optional `roles` object supplies defaults across scopes:

```json
{
  "version": 1,
  "roles": {
    "agent": "my-general-profile",
    "condenser": "my-small-profile",
    "oracle": "my-consultation-profile"
  },
  "scopes": {
    "whatsapp:main": { "agent": "my-main-profile" }
  }
}
```

An exact scope selection wins over the shared role selection. Omitted roles stay
unconfigured; a specialist role never implicitly borrows `agent`. As of 2026-09-18,
`agent` and `condenser` consume these selections. Other roles, including `oracle`,
remain separate work; storing their names does not enable their features.

The condenser first honors an explicit `agent_settings.condenser.llm_profile_ref`,
then the trusted scope's `condenser` selection, then `roles.condenser`. Its first use
captures an immutable profile/settings binding; later role/catalog edits and main
`switch_llm` choices do not change that binding. Configure the role before enabling
or running a summarizing condenser. Missing configuration fails clearly. See
[condensation](condensation.md) for defaults, commands and migration details.

## DeepSeek V4 Pro condenser

A shared selection applies to every registered scope that has no condenser override:

```json
{
  "version": 1,
  "roles": { "condenser": "deepseek-v4-pro" }
}
```

Merge that role into the existing file to retain its main-agent selections. The name
must reference a saved profile with provider `deepseek` and model `deepseek-v4-pro`.
For a 400,000-token input budget, save `maxInputTokens: 400000` in the profile through
its normal API; numeric limits are not `models.json` fields. Set the input budget on
each intended profile separately. Preserve `maxOutputTokens`, which controls output.
The input value is budget metadata, not a hard transport limit. For a main-context
condensation trigger, configure the main profile's input budget or the condenser
`max_tokens` setting; the summarizer does not independently enforce its own profile's
input budget before sending a summary prompt.
These catalog updates apply when a profile is captured; existing conversation snapshots
keep their saved values.

Checked 2026-09-18: DeepSeek's [official model details](https://api-docs.deepseek.com/quick_start/pricing/)
list V4 Pro at a 1M-token context window and a 384K maximum output. Its
[Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/)
defines provider `max_tokens` as output, capped at 393,216, with input plus generated
tokens limited by the context window. This differs from the SDK condenser setting
also named `max_tokens`, which is the main-context condensation threshold. See the
[condensation settings guide](condensation.md#configure-the-condenser).

## Changing a running conversation

Save edits atomically: write a complete temporary file and rename it over
`models.json`. The server reads the applicable selection when a conversation
runs. A changed selection applies at a safe boundary before a model call; it
does not interrupt a call or outstanding tools. The same conversation ID,
messages, tools, context snapshot and accumulated usage remain in place.

The agent can also use `switch_llm` with a saved `profile_name` and a `reason`.
The tool queues the selection for the next model call after the current tool
batch finishes. It does not wait for itself to finish. The selected profile is
durable across server restarts, including a switch in the final tool batch.

The latest applicable **change** wins. An unchanged channel setting does not
undo the agent's tool selection. Editing another channel or another role does
not reset this conversation. Changing the channel's selected name again does
override the earlier tool choice. Removing a scope override reveals the shared
`roles.agent` selection, if present. Removing the last applicable mapping leaves
the current conversation's choice intact; a new conversation uses its ordinary
creation settings (an explicit profile or the server default) when no mapping applies.

Editing a profile record without changing its selected name leaves existing
conversation snapshots intact. Explicitly selecting it again with `switch_llm`
can load the current record. Profile names must exist on each server using the
configuration. A missing configured profile or invalid explicit configuration
reports a conversation error instead of silently running a different model.
A rejected `switch_llm` request returns an error tool observation and keeps the
working selection. REST creation still validates its initial requested profile
or server default, so that reference must name an existing profile.

Per-call usage retains the profile/model that served that call. Switching never
resets accumulated metrics. Provider-specific opaque reasoning is reused only
when its recorded origin is compatible with the selected profile; the durable
conversation history is preserved.

This is product policy in `apps/relay-server/src/models.ts`. The shared server
owns profile resolution and durable activation; the SDK owns the tool and safe
step boundary. The bridges do not each implement a model-switching mechanism.

## OpenAI output verbosity

Saved profiles accept optional `verbosity: "low" | "medium" | "high"`. Set it only
for a model and endpoint that support it. Chat Completions sends `verbosity`;
Responses sends `text.verbosity`. Omission preserves the provider default.
Verbosity controls output detail independently of `reasoningEffort`.

As with other profile edits, existing conversations retain their snapshot until
the profile is explicitly reselected. A catalog edit alone does not activate it.

## Anthropic prompt-cache duration

Cache policy belongs to the saved LLM profile, alongside its model and API options.
For native Anthropic profiles and Anthropic models through compatible proxies, use:

```json
{
  "cachingPrompt": true,
  "anthropicCacheTtl": "1h"
}
```

These are profile fields, not entries in `models.json` or a bridge registration file.
`anthropicCacheTtl` is optional and accepts `"5m"` and `"1h"`. When omitted, it stays
absent from profiles, API responses and saved conversation snapshots. For Anthropic
models, including compatible proxies, cache serialization treats omission as the
provider's five-minute behavior; other providers do not acquire an Anthropic TTL.
`"1h"` requests one-hour cache entries on the SDK's automatic Anthropic breakpoints; `cachingPrompt:false`
disables those markers. This setting is separate from OpenAI's `promptCacheRetention`
and does not enable caching for an unsupported model.

Update the complete saved profile through `POST /api/profiles/{name}`, preserving its
other fields. The catalog change affects new conversations. Existing conversations
keep their snapshots, including cache duration, after restart; explicitly reselecting
the same name with `switch_llm` adopts the updated profile at the next complete-step
boundary. Changing a profile's TTL does not reset its conversation or usage counters.

Cache hits and writes must still be measured from provider responses. A requested
cache duration does not prove reuse or a particular billed cost. See the
[server cache and accounting contract](../packages/openhands-agent-server/docs/ARCHITECTURE.md#llm-usage-and-costs)
for profile persistence and regression coverage.

### Verified local rollout — 2026-09-17

[SDK #42](https://github.com/smolpaws/openhands-agent/pull/42) and
[server #202](https://github.com/smolpaws/smolpaws/pull/202) added the setting and
re-vendored SDK `8c25a50`; that rollout deployed server build `61e5fed`.
The authorized idle rollout set one hour in the local Fable catalog record and
all five saved Anthropic conversation profiles. Verification preserved all 45
conversations, 2,666 event files, 22 context snapshots, and accumulated metrics.
The WhatsApp bridge process remained running; no production conversation was prompted.

Isolated Haiku checks through the eval proxy passed locally and in the GitHub
`LLM` environment with `ANTHROPIC_CACHE_TTL=1h`:
[Live LLM run](https://github.com/smolpaws/openhands-agent/actions/runs/35171163557).
They proved provider-reported one-hour writes, warm cache hits and restored
accounting. They did not wait a full hour. The production setting applies to
future requests; the rollout did not warm or extend an existing provider cache.
See the [LLM profile notebook](https://enyst.github.io/arch/llm-profiles.html#anthropic-cache-ttl)
for the implementation, policy, and verification record.

### Optional-field correction — 2026-09-17

[SDK #44](https://github.com/smolpaws/openhands-agent/pull/44) and
[server #205](https://github.com/smolpaws/smolpaws/pull/205) made the field optional
without inserting a schema default. The corrected server build is `6e53dc6`,
with SDK `4212592`. Omission now stays absent through profile parsing, REST,
storage and conversation restore; Anthropic's omitted-duration wire behavior is unchanged.

The idle rollout removed automatically inserted `5m` fields from three DeepSeek
snapshots. Read-only verification found all 42 non-Anthropic saved profiles without
the field, while all five Anthropic snapshots retained their explicit `1h`.
All 47 conversations, 2,713 event files, 24 context snapshots and accumulated metrics
were preserved. WhatsApp kept its process. The rollout sent no provider requests
or Main test prompts; the earlier Haiku live proof remains historical.
