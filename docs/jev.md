# Jev client and CLI

`src/shared/jev.ts` is a small client for manual TypeSafe Jev evaluations. It accepts text/JSON state and batches Noul, Choice and Score questions in one request. This feature does not change bridge routing, approvals, condensation or scheduled work.

Set `TYPESAFE_API_KEY` in the environment or store that account under the existing macOS Keychain service `smolpaws`. An explicit `apiKey` client option takes precedence. Use only public/synthetic inputs or content approved for this hosted service; never send secrets or private memory.

```ts
import { JevClient, noul, choice, score, gate } from './src/shared/jev.js';

const client = new JevClient();
const result = await client.ask('Please explain this error.', {
  needsReply: noul('Does this request a reply?'),
  kind: choice('Classify the request.', { question: 'Asks for information', task: 'Requests an action' }),
  urgency: score('Rate urgency.', ['Routine', 'Soon', 'Blocking']),
});
console.log(result.answers.kind.choice);
console.log(gate(result.answers.kind.confidence, { floor: 0.6, actAt: 0.85 }));
```

`gate` classifies Choice/Score confidence as `act`, `confirm` or `escalate`; it does not perform or authorize an action. Noul's number is a yes-probability and has no separate confidence field. Do not pass it to this helper as though it were confidence. Invalid confidence escalates; invalid thresholds throw.

The client currently supports string instructions, string descriptions for Choice criteria, and string arrays for Score levels. It validates the request and returned answer types, ranges and criteria. The provider supports additional structured question forms that this small client does not yet expose.

For the CLI, put `state` and `questions` in a JSON file:

```json
{
  "state": "Please explain this error.",
  "questions": {
    "needsReply": { "type": "noul", "instructions": "Does this request a reply?" }
  }
}
```

```sh
npx tsx scripts/jev.ts --file request.json --json
npx tsx scripts/jev.ts 'Hello' '{"reply":{"type":"noul","instructions":"Does this need a reply?"}}'
```

The CLI records successful-call metadata in `$SMOLPAWS_HOME_DIR/jev/calls.jsonl` (default `~/.smolpaws/jev/calls.jsonl`). It records model, token usage, estimated input cost, duration and question IDs; it does not log state, question instructions, answers or credentials. Keep question IDs and client `tag` metadata non-sensitive. Newly created directories/files use permissions 0700/0600.

The default is `jev-latest`; pass a versioned `model` client or per-call option for repeatable experiments. The response records the resolved model. Cost is an estimate using the published Jev 1.13 input rate of $0.042 per million tokens, checked 2026-09-29, and may need updating for other models or future prices. Duration includes receiving and parsing the response. Requests time out after 30 seconds by default and are not automatically retried. HTTP failures raise `JevError` with status and at most 500 characters of provider body; treat that body as sensitive because providers can echo input. Invalid successful responses also raise `JevError`; network/timeout errors propagate. The CLI prints only the error message.

Contract references: [API](https://docs.typesafe.ai/api), [models and pricing](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence).

Run `npm run shared:test` and `npm run typecheck`. Jev tests use synthetic responses, including a child-process CLI test; they do not call the hosted provider or access real credentials. A successful offline run verifies the client contract, not model quality or live account access.
