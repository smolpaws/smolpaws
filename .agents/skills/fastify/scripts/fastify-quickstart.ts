// Example Fastify + TypeBox setup. Run with: npx tsx scripts/fastify-quickstart.ts
import Fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

app.get(
  "/health",
  {
    schema: {
      response: {
        200: Type.Object({ ok: Type.Boolean() }),
      },
    },
  },
  async () => ({ ok: true }),
);

app.post(
  "/echo",
  {
    schema: {
      body: Type.Object({ message: Type.String() }),
      response: {
        200: Type.Object({ message: Type.String() }),
      },
    },
  },
  async (request) => ({ message: request.body.message }),
);

const runDemo = async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  console.log("/health status", response.statusCode, response.json());
  await app.close();
};

runDemo().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
