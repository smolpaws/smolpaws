# Conversation run error propagation

Current correction, September 16, 2026. Tracking: `smolpaws-wws`.

## Upstream source and disposition

`PORT`: the run-failure backstop from OpenHands/software-agent-sdk
[PR #4535](https://github.com/OpenHands/software-agent-sdk/pull/4535), commit
`1de2e6d1bfcf70c7c3d4eb13616811943f33dd75`, is already included in the canonical
vendored pin. This correction does not advance the pin or change the SDK vendor.

Source: `openhands-agent-server/openhands/agent_server/event_service.py`,
`_publish_error_event_sync` and the exception handler around conversation execution.
Upstream persists and publishes a `ConversationErrorEvent` for failures outside the SDK's normal
error path. The previous TypeScript handler only logged an exception and published an error state;
event consumers therefore had no durable error to show.

The frozen SDK review `transpile/updates/54dfbc5..322dec7.md` classified this commit too broadly as
`NO_TARGET_CHANGE`. This current note supersedes that conclusion for the server run-failure path;
the historical review remains unchanged. The same upstream commit also touches title-generation
failure handling. This note claims only the run-failure port: the TS server's current title operation
uses a local text fallback, without the Python LLM auto-title execution path.

## TypeScript adaptation and ownership

`EventService` catches failures per run, including agent-factory failures, and appends the SDK
`conversationErrorEventSchema` to its existing `ConversationState`/`EventLog`. New durable events
are published before the final state update. No second event store or error type is introduced.

Python recognizes `ConversationRunError` when its SDK already emitted the error. TS has no matching
wrapper, so it checks events appended during the current invocation. An old error cannot suppress a
later failure. Subsequent user prompts retain the conversation and its history; failed construction
can be retried. Max-iteration errors already emitted by the SDK use the same event stream.

`DEV-SERVER-003` applies: exception messages pass through SDK secret redaction and authorization
scheme redaction before persistence or logging. Persisted/public events retain only a stable
exception class name and redacted message.

Conversation run, cleanup, rerun and ownership-lease renewal failures use the server's **error-level** logger. Structured
records include the conversation ID and, for run failures, elapsed milliseconds; the logger supplies
timestamp, PID and level. Local diagnostics add stack frames and a bounded cause tree, including
AggregateError members. Causes contain only exception class names, allowlisted native error codes,
numeric errno, allowlisted syscalls, IP addresses/ports and redacted stack frames. Cause messages,
HTTP URLs in stack frames, attached request/response objects and arbitrary thrown objects are never serialized.
Projection skips cause/metadata getters, omits error-message lines from stacks, and caps cause count,
depth, frame count and text length. This is not a guarantee that arbitrary unstructured text can be
made secret-free. No SDK/event schema, provider retry behavior or chat notice changes.

SmolPaws owns user notices in `src/coordinator/messageRelay.ts`. All `ConversationErrorEvent`
instances project into its existing durable outbox; max-iteration events have specific wording and
other codes have a generic notice. Errors are separate from terminal-reply echo suppression. Event
identity provides retry/restart deduplication. Recoverable `AgentErrorEvent` and failed tool
observations do not become conversation-error notices. Deployment does not rewind historical
projection cursors or rerun unfinished user work.

## Tests and evidence

Adapted first from pinned `tests/agent_server/test_event_service.py`:

- `test_run_exception_emits_conversation_error_event`
- `test_run_conversation_run_error_does_not_double_emit`

`src/__tests__/conversationError.test.ts` proved red before the port and covers HTTP/WebSocket
publication, persisted restart, repeated failures, factory recovery, existing-error deduplication,
and credential nonexposure. The existing `profileContext.test.ts` logging assertion now expects
the safe summary.

Cross-boundary regression: `apps/whatsapp/src/__tests__/conversationError.test.ts` uses the actual
server, SDK conversation, SQLite outbox and bridge with a fake transport. It proves max-step notice,
same-conversation follow-up with completed tool work, restart deduplication, a later distinct failure,
provider exception notice, and another successful follow-up. No external channel messages are sent.

Run the package CI and coordinator/bridge suites; the REST/OpenAPI contract is unchanged.
