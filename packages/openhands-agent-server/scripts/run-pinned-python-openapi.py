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

    runpy.run_path(str(generator), run_name="__main__")


if __name__ == "__main__":
    main()
