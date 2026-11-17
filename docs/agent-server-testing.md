# Agent-server tests

Run the product composition and relay tests from the repository root:

```sh
npm run relay-server:typecheck
npm run relay-server:test
npm run coordinator:test
npm run shared:test
npm run github:test
npm run email:test
```

The upstream-shaped server has its own full gate:

```sh
npm run ci --prefix packages/openhands-agent-server
```

`apps/relay-server/src/webhookBridges.test.ts` sends real HTTP from the Worker clients into the
product host. It exercises SQLite intake, agent execution, outbound delivery, duplicate submissions,
and restart recovery. Only the external GitHub/Resend network boundary is substituted.
Heartbeat tests live beside the product host, including its real-server task-tool integration.
