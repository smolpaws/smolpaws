# Consume the file editor host-path fix

Engel requested removal of the obsolete editor-only workspace restriction. SDK PR [#65](https://github.com/smolpaws/openhands-agent/pull/65) removes the lexical prefix rejection while retaining constructor options and the existing command/schema contract. This PR re-vendors its exact merged commit using `scripts/vendor-openhands-agent.sh` and adds a server profile-tool regression.

The unchanged upstream pin remains `d128a786ee2ee570eb23ff5862ec148b43cfad0b`; no upstream interval is advanced. The intervening SDK #50 change is live-test tooling only and does not enter the vendored runtime. The SDK manifest and this server's review inventories remain unchanged.

The new test calls the real profile tool resolver, configured with a workspace, then creates/replaces/undoes an absolute file in a sibling temporary private directory. Red on the old vendor (`Path escapes workspace`), green on the new vendor. SDK tests also cover view/insert and existing-file protection. Filesystem permissions still apply. REST upload/download allowed roots, auth, unrelated tools, and server configuration remain unchanged.

Self-review includes generated ESM/CJS runtime changes, source maps, declaration compatibility, exact SDK provenance, profile factory behavior and the filesystem-access boundary. This patch is not an OS sandbox and makes no new sandbox claim. No running service restart is part of the merge.
