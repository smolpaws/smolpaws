#!/usr/bin/env python3
"""Fresh-process compiler comparison; never treat a failed check as a speedup."""

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import time
from pathlib import Path


def run(command, cwd, log, timeout=180):
    start = time.perf_counter()
    try:
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        code, output = result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired as error:
        code, output = 124, str(error)
    elapsed = time.perf_counter() - start
    log.write_text(output)
    return {
        "exit": code,
        "seconds": elapsed,
        "diagnostics": re.findall(r"error TS\d+", output),
        "output_sha256": hashlib.sha256(output.encode()).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--tools", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 10:
        parser.error("rounds must be 1..10")
    project, tools, out = (
        args.project.resolve(),
        args.tools.resolve(),
        args.out.resolve(),
    )
    out.mkdir(parents=True, exist_ok=True)
    commands = {
        name: [
            str(
                (project / "node_modules/.bin/tsc")
                if name == "tsc"
                else tools / "node_modules/.bin" / name
            )
        ]
        for name in ("tsc", "tsgo", "tsc-ts")
    }
    versions = {
        name: subprocess.check_output(cmd + ["--version"], text=True).strip()
        for name, cmd in commands.items()
    }
    resolved = json.loads(
        subprocess.check_output(
            commands["tsc"] + ["--showConfig", "-p", "tsconfig.json"],
            cwd=project,
            text=True,
        )
    )
    # Preserve the project contract; never disable strictness for a timing.
    options = resolved["compilerOptions"]
    adjustments = []
    if "baseUrl" in options:
        if options["baseUrl"] not in (".", "./"):
            raise RuntimeError("Nontrivial baseUrl requires manual review")
        del options["baseUrl"]
        options.setdefault("paths", {}).setdefault("*", ["./*"])
        adjustments.append('Replace baseUrl:"." with paths["*"]:["./*"] for TS7')
    options["noEmit"] = True
    # All trials are cold compiler processes, not incremental-cache hits.
    options["incremental"] = False
    config = project / ".compiler-benchmark.json"
    probe = project / options.get("rootDir", ".") / "compiler-benchmark-negative.ts"
    if config.exists() or probe.exists():
        raise RuntimeError("Refusing to overwrite existing benchmark files")
    data = {
        "time": datetime.datetime.now(datetime.UTC).isoformat(),
        "versions": versions,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "project": str(project),
        "adjustments": adjustments,
        "rounds": args.rounds,
        "original": {},
        "warmup": {},
        "negative": {},
        "trials": [],
        "summary": {},
    }
    config.write_text(json.dumps(resolved, indent=2))
    (out / "resolved-config.json").write_text(json.dumps(resolved, indent=2))
    try:
        for name, cmd in commands.items():
            data["original"][name] = run(
                cmd + ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"],
                project,
                out / f"original-{name}.log",
            )
            data["warmup"][name] = run(
                cmd + ["-p", config.name, "--pretty", "false"],
                project,
                out / f"warmup-{name}.log",
            )
        eligible = [name for name in commands if data["warmup"][name]["exit"] == 0]
        probe.write_text(
            "export const numberAsString: string = 42;\n"
            'export const invalidMode: "safe" | "fast" = "wrong";\n'
            "function needsNumber(value: number) { return value; }\n"
            'needsNumber("wrong");\n'
        )
        negative_config = {
            **resolved,
            "files": resolved.get("files", [])
            + ["./" + probe.relative_to(project).as_posix()],
        }
        config.write_text(json.dumps(negative_config, indent=2))
        for name in eligible:
            data["negative"][name] = run(
                commands[name] + ["-p", config.name, "--pretty", "false"],
                project,
                out / f"negative-{name}.log",
            )
            negative = data["negative"][name]
            negative["passed"] = negative["exit"] != 0 and sorted(
                negative["diagnostics"]
            ) == ["error TS2322", "error TS2322", "error TS2345"]
        probe.unlink()
        config.write_text(json.dumps(resolved, indent=2))
        for index in range(args.rounds):
            order = (
                eligible[index % len(eligible) :] + eligible[: index % len(eligible)]
                if eligible
                else []
            )
            for name in order:
                result = run(
                    commands[name] + ["-p", config.name, "--pretty", "false"],
                    project,
                    out / f"round-{index + 1}-{name}.log",
                )
                data["trials"].append({"compiler": name, "round": index + 1, **result})
        for name in commands:
            trials = [r for r in data["trials"] if r["compiler"] == name]
            comparable = (
                len(trials) == args.rounds
                and all(r["exit"] == 0 for r in trials)
                and data["negative"].get(name, {}).get("passed", False)
            )
            if comparable:
                times = [r["seconds"] for r in trials]
                data["summary"][name] = {
                    "status": "comparable",
                    "median_seconds": statistics.median(times),
                    "min_seconds": min(times),
                    "max_seconds": max(times),
                }
            else:
                data["summary"][name] = {
                    "status": "not-comparable",
                    "reason": (
                        "See original, warmup, negative and trial diagnostics; "
                        "no speedup claimed."
                    ),
                }
        (out / "results.json").write_text(json.dumps(data, indent=2))
        lines = [
            "# TypeScript compiler benchmark",
            "",
            "Fresh processes; warm filesystem; no emit/incremental cache. "
            "Setup and typegen excluded.",
            "",
            "| Compiler | Version | Status | Median (s) | Range (s) |",
            "|---|---|---|---:|---:|",
        ]
        for name, summary in data["summary"].items():
            timing = (
                f"{summary['median_seconds']:.3f}"
                if "median_seconds" in summary
                else "—"
            )
            span = (
                f"{summary['min_seconds']:.3f}–{summary['max_seconds']:.3f}"
                if "min_seconds" in summary
                else "—"
            )
            lines.append(
                f"| {name} | {versions[name]} | {summary['status']} | "
                f"{timing} | {span} |"
            )
        lines += [
            "",
            "## Limits",
            "",
            (
                "This is not compiler-equivalence proof. Compiler/lib versions and "
                "default parallelism differ. The npm tsgo build is older than "
                "tsc-ts's upstream version. Diagnostics and unsuccessful attempts "
                "are retained. Negative controls check three error codes, not full "
                "diagnostic equivalence. This measures typechecking only, not "
                "Vite/tsup builds or declaration emit."
            ),
            "",
            "Config adjustments: " + ("; ".join(adjustments) or "none"),
            "",
            "Original config results: "
            + json.dumps({k: v["exit"] for k, v in data["original"].items()}),
            "",
        ]
        (out / "report.md").write_text("\n".join(lines))
        print("\n".join(lines))
    finally:
        config.unlink(missing_ok=True)
        probe.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
