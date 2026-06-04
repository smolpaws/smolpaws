---
name: apple-instruments
description: "CLI-first guide to profiling, debugging, and inspecting apps and processes on macOS using xctrace, leaks, sample, fs_usage, and other Apple developer tools."
---

# Apple Instrumentation & Profiling

CLI-first guide to profiling, debugging, and inspecting apps and processes on macOS. Use these instead of opening GUI tools — agents work better with terminal commands.

Run `system_profiler SPSoftwareDataType` and `xcrun xctrace version` to check the current OS and toolchain versions.

## Quick Reference

| What you want | Command |
|---|---|
| Profile CPU | `xcrun xctrace record --template 'Time Profiler' --attach PID` |
| Find memory leaks | `leaks PID` |
| Profile memory allocations | `xcrun xctrace record --template 'Allocations' --attach PID` |
| Sample a stuck process | `sample PID 5 -f /tmp/sample.txt` |
| Watch file I/O | `sudo fs_usage -w PID \| head -n 200` |
| Monitor network | `xcrun xctrace record --template 'Network' --attach PID` |
| System-wide CPU/power | `sudo powermetrics --samplers cpu_power -i 1000 -n 5` |
| Memory pressure | `vm_stat` |
| Disk I/O stats | `iostat -w 1 -c 5` |
| Spin dump (hang) | `sudo spindump PID -o /tmp/spindump.txt -reveal -timeline` |
| Check app launch time | `xcrun xctrace record --template 'App Launch' --launch -- /path/to/app` |
| SwiftUI performance | `xcrun xctrace record --template 'SwiftUI' --attach PID` |
| Energy impact | `xcrun xctrace record --template 'Power Profiler' --attach PID` |

## xctrace — The Main Tool

`xcrun xctrace` is the CLI for Apple Instruments. It records traces without opening the GUI.

### Record a trace

```bash
# Profile a running process by PID
xcrun xctrace record --template 'Time Profiler' --attach PID --time-limit 10s --output /tmp/trace.trace

# Launch and profile an app
xcrun xctrace record --template 'Time Profiler' --launch -- /path/to/binary --arg1 --arg2

# Profile with a specific template for 30 seconds
xcrun xctrace record --template 'Allocations' --attach PID --time-limit 30s --output /tmp/alloc.trace
```

### Export trace data (for agent parsing)

```bash
# Export as XML (parseable)
xcrun xctrace export --input /tmp/trace.trace --xpath '/trace-toc/run/data/table[@schema="time-profile"]'

# List the table of contents and available schemas
xcrun xctrace export --input /tmp/trace.trace --toc
```

### Available templates on this machine

```
Activity Monitor        — lightweight process overview
Allocations             — memory allocation tracking
Animation Hitches       — UI frame drops
App Launch              — startup time profiling
CPU Counters            — hardware performance counters
CPU Profiler            — detailed CPU profiling
Core ML                 — ML model performance
Data Persistence        — Core Data / file writes
File Activity           — disk I/O
Leaks                   — memory leak detection
Logging                 — os_log / unified logging
Metal System Trace      — GPU profiling
Network                 — network activity
Power Profiler          — energy impact
Swift Concurrency       — async/await, actors, tasks
SwiftUI                 — SwiftUI view updates, body evaluations
System Trace            — full system (CPU, I/O, threads)
Time Profiler           — CPU time profiling (the classic)
```

### List connected devices
```bash
xcrun xctrace list devices
```

## Memory Debugging

### leaks — find memory leaks in a running process
```bash
leaks PID                           # scan for leaks
leaks PID --outputGraph /tmp/leaks  # generate a graph file
leaks --atExit -- /path/to/binary   # run binary, check leaks on exit
```

### heap — show heap allocations
```bash
heap PID                            # summary of all heap allocations
heap PID -sortBySize                # sort by total size
heap PID -addresses all             # show every allocation (verbose)
```

### malloc debugging
```bash
# Run a binary with malloc diagnostics
MallocStackLogging=1 MallocScribble=1 /path/to/binary
# Then use leaks/heap with stack traces
leaks PID --groupByType
```

## CPU & Performance

### sample — lightweight CPU sampling
```bash
sample PID 5                        # sample for 5 seconds, print to stdout
sample PID 10 -f /tmp/sample.txt    # save to file
```
Good for quick "what is this process doing?" without a full Instruments trace.

### spindump — diagnose hangs
```bash
sudo spindump PID -o /tmp/spindump.txt -reveal -timeline
sudo spindump PID -o /tmp/spindump-target.txt -reveal -timeline -onlyTarget
```

### powermetrics — energy and thermal
```bash
sudo powermetrics --samplers cpu_power -i 1000 -n 5    # CPU power, 5 samples at 1s
sudo powermetrics --samplers all -i 2000 -n 3          # everything
sudo powermetrics --samplers gpu_power -i 1000 -n 5    # GPU power
```
Requires root. Shows power per cluster (E-cores, P-cores), thermal pressure, frequency.

## File System & I/O

### fs_usage — live file system activity
```bash
sudo fs_usage -w PID | head -n 200 # bounded sample of file ops
sudo fs_usage -w -f filesys PID    # file system calls only
sudo fs_usage -w -f network PID    # network calls only
sudo fs_usage -w -f diskio PID     # disk I/O only
```

### iostat — disk I/O statistics
```bash
iostat -w 1 -c 5                    # disk stats every second, 5 samples
iostat -d -w 1 -c 5                 # disk only, 5 samples
```

## System Overview

### vm_stat — memory pressure
```bash
vm_stat                             # one-shot memory snapshot
```
Watch for "Pages speculative" and "Pages purgeable" to gauge memory pressure.

### top — process overview
```bash
top -l 1 -s 0 -o cpu               # one snapshot, sorted by CPU
top -l 5 -s 1 -stats pid,command,cpu,mem,time  # 5 samples, specific columns
```

### system_profiler — hardware/software info
```bash
system_profiler SPHardwareDataType     # CPU, memory, serial
system_profiler SPSoftwareDataType     # OS version, kernel
system_profiler SPDeveloperToolsDataType  # Xcode version
```

## DTrace — Advanced Tracing

```bash
# Count syscalls by name for a process
sudo dtrace -n 'syscall:::entry /pid == PID/ { @[probefunc] = count(); }'

# Trace file opens
sudo dtrace -n 'syscall::open*:entry /pid == PID/ { printf("%s", copyinstr(arg0)); }'
```
DTrace requires SIP adjustments on modern macOS for some probes.

## Xcode Build from CLI

```bash
# Build a project
xcodebuild -project MyApp.xcodeproj -scheme MyApp -configuration Debug build

# Build and test
xcodebuild -project MyApp.xcodeproj -scheme MyApp test

# Clean
xcodebuild -project MyApp.xcodeproj -scheme MyApp clean

# List schemes
xcodebuild -list -project MyApp.xcodeproj
```

## For SmolPawsBall specifically

The Swift menu bar app at `~/repos/mac-ball/SmolPawsBall/`:

```bash
# Build from CLI
cd ~/repos/mac-ball/SmolPawsBall
xcodebuild -project SmolPawsBall.xcodeproj -scheme SmolPawsBall -configuration Debug build

# Run tests
xcodebuild -project SmolPawsBall.xcodeproj -scheme SmolPawsBall test

# Profile CPU (xctrace accepts process name directly)
xcrun xctrace record --template 'Time Profiler' --attach 'SmolPawsBall' --time-limit 10s --output /tmp/smolpawsball.trace

# Check for leaks (also accepts process name)
leaks SmolPawsBall

# Profile SwiftUI (if using SwiftUI views)
xcrun xctrace record --template 'SwiftUI' --attach 'SmolPawsBall' --time-limit 10s --output /tmp/smolpawsball_swiftui.trace
```

## Tips for Agents

- **Always prefer CLI over GUI.** `xctrace record` over opening Instruments.app.
- **Use `--time-limit`** to prevent traces from running forever.
- **Export traces in two steps.** Use `xcrun xctrace export --input file.trace --toc` to discover schemas, then `--xpath` to export the actual data you want.
- **`sample` is the quickest win** for "what is this process doing right now?" It may need `sudo` for protected processes.
- **`leaks` needs no setup** — just point at a PID.
- **Limit streaming commands** like `fs_usage` and `iostat` so the shell does not hang waiting for more samples.
- **`sudo` is required** for `fs_usage`, `powermetrics`, `spindump`, and `dtrace`, and is often needed for `sample`.
