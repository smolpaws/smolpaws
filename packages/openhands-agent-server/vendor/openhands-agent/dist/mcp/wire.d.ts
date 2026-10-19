/** MCP 1/2 persistence compatibility. Only protocol fields are renamed; JSON Schema and metadata are opaque. */
export declare function normalizeMcpToolWire(value: unknown): unknown;
/** System prompt records may contain native tools as well as serialized MCP definitions. */
export declare function normalizePersistedMcpTool(tool: Record<string, unknown>): Record<string, unknown>;
/** Match exclude_none on typed MCP fields without modifying opaque JSON data. */
export declare function serializeMcpToolWire(value: unknown): unknown;
