# Agent SDK LLM settings

Sources: `packages/agent-sdk/src/sdk/types/settings.ts` and `packages/agent-sdk/src/sdk/llm/profiles.ts`.

## LLMSettings fields

- `profileId`: optional profile identifier (overrides raw LLM fields when set).
- `provider`, `model`, `baseUrl`, `apiVersion`.
- `openaiApiMode`: `chat_completions` or `responses` (OpenAI-specific).
- `timeout`, `temperature`, `topP`, `topK`.
- `maxInputTokens`, `maxOutputTokens`.
- `reasoningEffort`: `low` | `medium` | `high` | `none`.
- `reasoningSummary`: `auto` | `concise` | `detailed` (responses-only).
- `inputCostPerToken`, `outputCostPerToken`.

When `profileId` is set, raw LLM fields above are cleared via `clearRawLlmFieldsWhenProfileSelected`.

## Providers

Supported providers in profiles: `openai`, `litellm_proxy`, `openrouter`, `anthropic`, `gemini`.

## LLM profiles

- Profiles live under `~/.openhands/llm-profiles/<profileId>.json`.
- `LLMProfileStore` validates profile IDs and payloads.
- `apiKeyRef` supports `{ kind: "key", name }` (secret reference) or `{ kind: "inline", value }`.
- Legacy `apiKey` in profile JSON is treated as a key reference name.
