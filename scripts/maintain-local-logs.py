#!/usr/bin/env python3
"""Keep bounded tails of append-only service logs without replacing live inodes."""

import argparse
import fcntl
import gzip
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from datetime import datetime, timezone


DEFAULT_LOGS = (
    "openhands-agent-server-8790.log",
    "openhands-agent-server-8790.error.log",
)


def regular_file(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Expected a regular file with exactly one hardlink")
    return info


def atomic_write(destination, data):
    """Replace only the checkpoint, never the active log; temp files are private."""
    fd, temporary = tempfile.mkstemp(prefix=".log-maintenance-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def maintain_log(log, max_bytes, tail_bytes, dry_run):
    # O_NONBLOCK prevents a mistakenly configured FIFO from hanging the job.
    try:
        fd = os.open(log, (os.O_RDONLY if dry_run else os.O_RDWR)
                     | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {"log": log.name, "status": "missing"}
    try:
        before = regular_file(fd)
        decision = {"log": log.name, "bytes": before.st_size,
                    "status": "rotate" if before.st_size > max_bytes else "unchanged"}
        if dry_run or before.st_size <= max_bytes:
            return decision
        start = max(0, before.st_size - tail_bytes)
        tail = os.pread(fd, before.st_size - start, start)
        if len(tail) != before.st_size - start:
            raise RuntimeError("Log changed while reading its tail; refusing to truncate")
        compressed = gzip.compress(tail, mtime=0)
        if gzip.decompress(compressed) != tail:
            raise RuntimeError("Tail verification failed; refusing to truncate")
        atomic_write(log.with_name(log.name + ".tail.gz"), compressed)
        current = os.stat(log, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("Log path changed; refusing to truncate")
        regular_file(fd)
        # Writers must use O_APPEND. A concurrent write between snapshot and
        # truncate can be lost, as with copytruncate; these are diagnostics only.
        os.ftruncate(fd, 0)
        os.fsync(fd)
        decision["tail_bytes"] = len(tail)
        return decision
    finally:
        os.close(fd)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path,
                        default=Path(os.environ.get("SMOLPAWS_HOME_DIR", Path.home() / ".smolpaws")))
    parser.add_argument("--log", action="append", help="A service log basename under HOME/logs")
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--tail-bytes", type=int, default=200_000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    args.log = args.log or DEFAULT_LOGS
    if not 0 < args.tail_bytes < args.max_bytes:
        parser.error("Require 0 < tail-bytes < max-bytes")
    if any(Path(name).name != name or name.startswith(".") or not name.endswith(".log")
           for name in args.log):
        parser.error("Each log must be a non-hidden .log basename")
    return args


def main():
    args = arguments()
    logs = args.home / "logs"
    if not logs.exists():
        if args.dry_run:
            print(json.dumps({"status": "missing_logs_directory"}))
        return 0
    lock = None
    try:
        if not args.dry_run:
            lock = os.open(logs / ".log-maintenance.lock",
                           os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            regular_file(lock)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
        results = []
        errors = []
        for name in args.log:
            try:
                results.append(maintain_log(logs / name, args.max_bytes,
                                            args.tail_bytes, args.dry_run))
            except (OSError, ValueError, RuntimeError) as error:
                errors.append({"log": name, "error": str(error)})
        status = {"checked_at": datetime.now(timezone.utc).isoformat(),
                  "results": results, "errors": errors}
        if args.dry_run:
            print(json.dumps(status))
        else:
            # One replaced status file reports errors without an unbounded job log.
            atomic_write(logs / ".log-maintenance-status.json", json.dumps(status).encode())
        if errors:
            print(json.dumps(errors), file=sys.stderr)
        return 1 if errors else 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Log maintenance failed: {error}", file=sys.stderr)
        return 1
    finally:
        if lock is not None:
            os.close(lock)


if __name__ == "__main__":
    sys.exit(main())
