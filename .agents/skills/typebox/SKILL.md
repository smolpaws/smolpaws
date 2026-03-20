---
name: typebox
description: TypeBox JSON Schema builder and runtime validation for TypeScript. Use when defining schemas, inferring types, or validating data with TypeBox.
metadata:
  tags: typebox, json-schema, typescript, validation
  source: https://github.com/sinclairzx81/typebox
---

# TypeBox

Use this skill when you need to define JSON Schema with TypeBox, infer TypeScript types, or validate runtime data.

## Key usage

- Define schemas with `Type.*` helpers.
- Infer types using `Static<typeof Schema>`.
- Validate runtime data with `Value.Check`/`Value.Parse` or `TypeCompiler`.

## References

- [references/typebox-docs.md](references/typebox-docs.md) - TypeBox README highlights and doc links.

## Scripts

- [scripts/typebox-demo.ts](scripts/typebox-demo.ts) - Minimal schema + runtime validation example.
