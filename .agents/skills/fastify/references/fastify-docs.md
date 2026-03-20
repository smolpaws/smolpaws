# Fastify official docs highlights

Sources: Fastify reference docs for [Server](https://fastify.dev/docs/latest/Reference/Server/), [Routes](https://fastify.dev/docs/latest/Reference/Routes/), [Plugins](https://fastify.dev/docs/latest/Reference/Plugins/), [Validation & Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), and [Testing](https://fastify.dev/docs/latest/Guides/Testing/).

## Core APIs

- **Server factory**: `Fastify()` creates a server instance. Configure logging, router options, request timeouts, and schema/compiler options via the factory options. Use `listen({ host: '0.0.0.0' })` when running in containers.
- **Routes**: Define routes with `fastify.route({ method, url, schema, handler })` or shorthand methods (`fastify.get`, `post`, etc.). Use `schema` to describe `body`, `querystring`, `params`, and `headers` with JSON Schema.
- **Plugins & encapsulation**: `fastify.register(plugin, options)` creates a new scope. Use `fastify-plugin` if you need to expose decorators to parent scopes or share encapsulated state across plugins.

## Validation & serialization

- Fastify validates input only for `application/json` content types by default and relies on **Ajv v8** for schema validation.
- Use `addSchema()` to register shared schemas, then reference them with `$ref`.
- Response serialization uses **fast-json-stringify** when response schemas are present, which improves performance and helps avoid leaking fields.
- If you need custom validators/serializers, use `setValidatorCompiler` / `setSerializerCompiler`, and return `{ error }` objects instead of throwing errors when using async hooks.

## Testing

- Prefer `fastify.inject()` (powered by `light-my-request`) to test without opening a network port.
- Separate application setup from server startup so tests can create isolated instances.
- Remember to call `fastify.close()` in tests to release resources.

## Practical links

- [Server reference](https://fastify.dev/docs/latest/Reference/Server/)
- [Routes reference](https://fastify.dev/docs/latest/Reference/Routes/)
- [Plugins reference](https://fastify.dev/docs/latest/Reference/Plugins/)
- [Validation & serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Testing guide](https://fastify.dev/docs/latest/Guides/Testing/)
