# OpenHands Agent SDK LLM profiles and secrets

Use current schemas and factories from `@smolpaws/openhands-agent`; do not reconstruct the API from this prose.

## Stable invariants

- Product/REST configuration is profile-first: callers select a validated `LLMProfile`.
- Host applications own profile persistence. The SDK does not impose one global profile directory or singleton registry.
- Generic dispatch uses `createClientFromProfile(profile, secretStore)`.
- Credential lookup follows `providerId`, not guesses from the model name.
- Provider-scoped credentials are the default; explicit profile-scoped overrides are used only when configured.
- Persistent profiles/settings store secret references, never raw API-key values.
- Low-level OpenAI, Anthropic, Gemini, and compatible clients may be used for provider-specific tests or advanced integrations, but are not the normal product boundary.
- Provider-native reasoning, caching, tools, and continuation metadata remain in provider-specific clients rather than being flattened into a lossy common shape.

## Current source

Inspect the current `src/profiles/`, `src/settings/`, `src/secrets/`, and `src/llm/` code in [`enyst/openhands-agent`](https://github.com/enyst/openhands-agent) before changing fields or defaults.

Intentional differences from Python secret and LLM configuration behavior are defined in the transpilation contract, not here.
