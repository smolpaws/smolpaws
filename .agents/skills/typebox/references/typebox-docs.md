# TypeBox docs highlights

Sources: [TypeBox README](https://github.com/sinclairzx81/typebox) and [TypeBox documentation](https://sinclairzx81.github.io/typebox/).

## Overview

- TypeBox is a runtime type system that creates JSON Schema objects while inferring TypeScript types.
- Use `Type.*` builders to create schemas and `Static<typeof Schema>` to get TypeScript types.
- Runtime validation is available via `Value.Check`, `Value.Parse`, or the JIT compiler (`TypeCompiler`).

## Core APIs

### Schema creation

```ts
import { Type } from "@sinclair/typebox";

const User = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  age: Type.Optional(Type.Number({ minimum: 0 })),
});
```

### Type inference

```ts
import type { Static } from "@sinclair/typebox";

type User = Static<typeof UserSchema>;
```

### Runtime validation

```ts
import { Value } from "@sinclair/typebox/value";

if (!Value.Check(UserSchema, payload)) {
  throw new Error("Invalid payload");
}
```

## Useful links

- [TypeBox documentation](https://sinclairzx81.github.io/typebox/)
- [TypeBox README](https://github.com/sinclairzx81/typebox)
