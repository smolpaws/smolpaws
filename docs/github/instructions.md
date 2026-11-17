# GitHub ingress setup

Use the [GitHub relay guide](README.md) and [app instructions](../../apps/github/AGENTS.md).
Configure signature/allowlist checks on the Worker and session authentication on the product host.
The Worker submits durable intake; the host owns agent execution and outbound delivery.
There is no `/turns` endpoint, Worker-side run polling, or Daytona wake fallback.
