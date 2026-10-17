# Manual compiler benchmark

This opt-in workflow benchmarks a pinned source commit from `smolpaws/smolpaws` without replacing production checks or modifying its dependencies. No cron or push trigger; this dedicated benchmark PR runs it only when benchmark-owned files change. Run on the fork's Actions tab with the full source SHA. Five interleaved fresh-process no-emit runs after one warmup; setup/typegen excluded. Raw logs, exact tools lock, source and machine metadata, failed attempts and three type-error negative controls are retained as an artifact. Only successful comparable runs receive timings.

Native compilers are pinned: tsc-ts npm 0.0.2 (compiler 7.0.2), tsgo native-preview 7.0.0-dev.20260707.2. They have different upstream revisions/default parallelism, so this is a tool comparison, not a matched-commit compiler benchmark. The baseline uses the source checkout's locked tsc. Canvas's removed baseUrl is translated only in a temporary config shared by all tools; strictness is preserved. Existing tracked configs and compiler commands are unchanged.

The workflow checks out source separately from this harness. The source revision is pinned independently of the fork's older default branch. Read-only token, no secrets, no deployment, no external model calls. A green job means the benchmark completed, not that every compiler is compatible; consult each status and log. Results concern typechecking, not full app bundles/declaration emit or production adoption.

Local use after installing project dependencies and compiler tools in a separate directory:

```sh
python3 scripts/benchmark-typescript-compilers.py --project /absolute/project/path --tools /absolute/compiler-tools/path --out /tmp/compiler-results --rounds 5
```
