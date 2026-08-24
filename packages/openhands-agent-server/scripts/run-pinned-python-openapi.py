#!/usr/bin/env python3
"""Run the pinned upstream OpenAPI generator with one audited import shim.

The pinned workspace currently resolves an OpenAI package that no longer exposes
``openai._models`` while its pinned LiteLLM still imports ``BaseModel`` from that
private module. OpenAPI generation does not exercise LLM runtime behavior, but the
FastAPI app imports the SDK eagerly. We provide exactly the missing base class from
Pydantic, fail on every other import problem, and then execute the untouched pinned
generator.
"""

from __future__ import annotations

import os
import runpy
import sys
import types
from pathlib import Path


def install_openai_models_compatibility_shim() -> bool:
    try:
        import openai._models  # type: ignore[import-not-found]  # noqa: F401

        return False
    except ModuleNotFoundError as exc:
        if exc.name != "openai._models":
            raise

    import openai
    from pydantic import BaseModel

    module = types.ModuleType("openai._models")
    module.BaseModel = BaseModel  # type: ignore[attr-defined]
    sys.modules["openai._models"] = module
    setattr(openai, "_models", module)
    return True


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: run-pinned-python-openapi.py /path/to/openapi.py")

    generator = Path(sys.argv[1]).resolve()
    if not generator.is_file():
        raise SystemExit(f"generator not found: {generator}")

    shimmed = install_openai_models_compatibility_shim()
    if shimmed:
        print(
            "Applied schema-only compatibility shim: "
            "openai._models.BaseModel = pydantic.BaseModel",
            file=sys.stderr,
        )

    # The pinned generator (54dfbc5+) no longer ships a ``__main__`` block; the
    # canonical public OpenAPI document is produced through the library API:
    # ``build_public_openapi()`` builds the filtered /api surface and
    # ``serialize_openapi()`` renders it deterministically. Older pins resolved
    # ``SCHEMA_PATH`` and ran the module directly; keep that path as a fallback
    # so the bootstrap stays valid across the pin history.
    schema_path = os.environ.get("SCHEMA_PATH")
    if schema_path is None:
        raise SystemExit("SCHEMA_PATH environment variable is required")

    # ``openhands`` is the top-level package rooted at ``openhands-agent-server/``.
    sys.path.insert(0, str(generator.parent.parent.parent))
    module = runpy.run_path(str(generator), run_name="openhands_agent_server_openapi")
    build_public_openapi = module.get("build_public_openapi")
    serialize_openapi = module.get("serialize_openapi")
    if callable(build_public_openapi) and callable(serialize_openapi):
        document = build_public_openapi()
        Path(schema_path).write_text(serialize_openapi(document), encoding="utf-8")
        print(f"Wrote {schema_path}")
        return

    # Fallback for pre-54dfbc5 generators that self-execute under ``__main__``.
    runpy.run_path(str(generator), run_name="__main__")


if __name__ == "__main__":
    main()
