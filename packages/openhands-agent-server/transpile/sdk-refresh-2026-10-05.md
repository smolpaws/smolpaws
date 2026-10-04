# SDK package refresh — 2026-10-05

Re-vendored the clean SDK `main` commit `7972e074c4487b58c31910842c03039d9f31a970`, replacing `708e613aaf1496422f0a160a811ab9fb2dc7e757`. This same-pin refresh adopts the remote create/attach and UUID fixes from SDK PR #57 and terminal observation output limits from SDK PR #59. The upstream manifest, Python OpenAPI and bounded server review records remain unchanged and agree.

`scripts/vendor-openhands-agent.sh` built and packed the SDK, refreshed the installed package, and checked provenance and review completeness. Lockfiles did not change. Generated bundles/declarations are package artifacts; no SDK behavior was edited in this repository.

Verification: 1,152 SDK tests; the full server CI (provenance, server reviews, OpenAPI, tests, local smoke, coverage, typechecks, lint, build and packed-consumer smoke); 228 final server tests including `remoteSdkContract.test.ts`; 110 coordinator tests; 76 relay-host tests; root and relay typechecks. The new real HTTP test checks selected-profile preservation, compact UUID attachment and missing-profile rejection using the installed vendored package, temporary state and TestLLM. No paid-provider calls.

This is a repository package update. It does not restart or deploy a resident relay/server. Runtime activation follows the normal release rollout after the PR merges.
