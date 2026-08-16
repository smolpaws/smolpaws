#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from openhands.agent_server.api import api


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonicalize(entry) for entry in value]
    return value


def response_body(response: Any) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return canonicalize(response.json())
    return response.text


def main() -> None:
    args = parse_args()
    document = json.loads(Path(args.cases).read_text())
    if document.get("schemaVersion") != 1 or not isinstance(document.get("scenarios"), list):
        raise RuntimeError("Unsupported server-scenario document")

    results: dict[str, Any] = {}
    with TestClient(api) as client:
        for scenario in document["scenarios"]:
            scenario_id = scenario.get("id")
            method = scenario.get("method")
            path = scenario.get("path")
            if not isinstance(scenario_id, str) or not scenario_id:
                raise RuntimeError("Every scenario needs a non-empty id")
            if scenario_id in results:
                raise RuntimeError(f"Duplicate scenario id: {scenario_id}")
            if method != "GET" or not isinstance(path, str) or not path.startswith("/"):
                raise RuntimeError(f"Unsupported scenario request: {scenario}")

            response = client.get(path)
            results[scenario_id] = {
                "status": response.status_code,
                "contentType": response.headers.get("content-type", "").split(";", 1)[0],
                "body": response_body(response),
            }

    commit = os.environ.get("OPENHANDS_UPSTREAM_COMMIT", "")
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise RuntimeError("OPENHANDS_UPSTREAM_COMMIT must be a full lowercase SHA")

    output = {
        "schemaVersion": 1,
        "source": {
            "repository": "OpenHands/software-agent-sdk",
            "commit": commit,
        },
        "results": results,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {output_path} ({len(results)} server scenarios)")


if __name__ == "__main__":
    main()
