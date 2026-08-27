# OpenHands Agent SDK transpilation

The TypeScript SDK source lives in [`enyst/openhands-agent`](https://github.com/enyst/openhands-agent). SmolPaws consumes a built copy under `packages/openhands-agent-server/vendor/openhands-agent/`.

Do not treat the older `@smolpaws/agent-sdk` package or OpenHands-Tab implementation as the current source. They may be consulted as historical/product references only.

## Source documents

- [`docs/TRANSPILE_CONTRACT.md`](https://github.com/enyst/openhands-agent/blob/main/docs/TRANSPILE_CONTRACT.md) defines scope, compatibility policy, dispositions, and deliberate differences.
- [`docs/ARCHITECTURE.md`](https://github.com/enyst/openhands-agent/blob/main/docs/ARCHITECTURE.md) describes current implementation boundaries.
- [`docs/DRIFT_TOOLING.md`](https://github.com/enyst/openhands-agent/blob/main/docs/DRIFT_TOOLING.md) specifies the canonical pin, generated drift reports, and differential oracles.

Do not copy the current upstream SHA into this reference. Read it from the SDK's canonical provenance once implemented; until then, read the transpilation contract.

## Build and validation in the SDK repository

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```

## Upstream updates

Every update is a finite `OLD_PIN..NEW_PIN` review:

1. generate the source/test/example inventory;
2. classify each meaningful change;
3. port `PORT` items tests-first;
4. run deterministic parity evidence;
5. update the server transpile against the same final upstream commit;
6. move the pin only when the interval is fully reviewed.

Beads/issues track work, not compatibility truth.
