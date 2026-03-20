import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const UserSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  age: Type.Optional(Type.Number({ minimum: 0 })),
});

type User = Static<typeof UserSchema>;

const payload: unknown = {
  id: "28b7bb1b-3cc2-4ef4-99ea-5d5d7f251fd2",
  name: "Smol Paws",
  age: 3,
};

if (!Value.Check(UserSchema, payload)) {
  console.error("Invalid payload", Value.Errors(UserSchema, payload));
} else {
  const user = payload as User;
  console.log("Valid user", user);
}
