# Hourly watchdog

A short-lived Node/TypeScript job observes Main, Hunting, OpenHands and the daily
heartbeat. It uses existing dependencies, with no build or package installation.
It reads the current WhatsApp relay lane bindings and up to 24 recent events per
conversation. Scheduled sub-lanes are excluded.

`progress` means fresh operational activity, not proof of semantic task progress.
`stuck` means pending/running work without observed advancement, repeated events,
or an explicit blocked/error execution state. `idle` means no active work.
`stopped` means a required application process is confirmed absent.
Probe failures appear separately as errors; a missing verdict is null, never an
invented fifth state. When an old verdict is retained with an error, it is stale.

Jev is advisory and sees only execution state, counts, event age and repetition
indices, never messages, tool arguments, results, memory, chat IDs or paths.
The pinned model is jev-1.13.0. Without a key, network, or confident answer, runtime
activity supplies the verdict and the report marks the model limitation.
This is deliberately a lightweight activity detector, not a completion judge.

Recovery is restricted to the existing loaded LaunchAgents
`com.smolpaws.relay-server` and `com.smolpaws.bridge.whatsapp`. A disabled/unloaded
job or inconclusive probe does not authorize a restart. A live but unhealthy
process is not killed. The heartbeat launcher normally exits after its scheduled
run and is never restarted merely because it is absent.

On the first observed outage the watchdog starts a private timer. It waits until
a later hourly check establishes more than 15 minutes since that observation,
then rechecks process health and maintenance state. It uses `launchctl kickstart`
without `-k`, so it will not kill a concurrently recovered process. Attempts are
limited to one per service per hour and recorded before starting; recovery is
checked afterward. A reboot, uncertain probe, recovery, pause or resume resets
the observation window. Hourly observations do not establish an exact exit time.
No conversation reset, message send, or automatic response to `stuck` occurs.

From the SmolPaws checkout:

```sh
bash scripts/run-watchdog.sh check --dry-run --no-jev # no restart, no model call
bash scripts/run-watchdog.sh check                  # normal one-shot check
bash scripts/run-watchdog.sh status
bash scripts/run-watchdog.sh pause                  # observe but do not recover
bash scripts/run-watchdog.sh resume                 # fresh downtime window
bash scripts/run-watchdog.sh pause whatsapp         # leave WhatsApp stopped
bash scripts/run-watchdog.sh resume whatsapp        # remove its recovery pause
bash scripts/install-watchdog.sh                    # install hourly LaunchAgent
launchctl bootout gui/$(id -u)/com.smolpaws.watchdog  # stop hourly scheduling
```

A quick manual restart needs no pause; longer maintenance should use pause/resume.
Pause persists until explicitly resumed. Runtime files live in
`~/.smolpaws/watchdog/`: control, state, status, and the transient ownership lock.
The installer snapshots only the small required source files into `watchdog/runtime`,
with a symlink to the existing node_modules (no dependency copy). It keeps at most
one prior source snapshot. This lets scheduling survive checkout branch changes.
Use `bash ~/.smolpaws/watchdog/runtime/scripts/run-watchdog.sh status` from anywhere.
JSON files are replaced atomically with owner-only permissions. There are no
accumulating logs, transcript copies, dependencies or build artifacts. Launchd
runs the wrapper hourly independently of SmolPaws; it loads the normal private
environment and uses the existing Keychain entry TYPESAFE_API_KEY when needed.

Validation: `node --import tsx/esm --test src/watchdog/policy.test.ts` and
`npm run typecheck`. The script also requires a separate TypeScript check because
scripts are outside the root tsconfig include path.

An unloaded WhatsApp service remains stopped even after removing its recovery pause;
start it through the normal bridge installation flow when ready. The watchdog does
not bootstrap unloaded services. Per-service pauses are independent of the global pause.
