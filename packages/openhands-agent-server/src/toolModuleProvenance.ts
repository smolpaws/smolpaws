/** Protocol metadata only. Values are never dynamically imported or executed. */
export function mergeToolModuleQualnames(
  caller: Readonly<Record<string, string>>,
  trustedServerModules: Readonly<Record<string, string>>,
  clientToolNames: readonly string[] = [],
): Record<string, string> {
  const clients = new Set(clientToolNames);
  return { ...Object.fromEntries(Object.entries(trustedServerModules).filter(([name]) => !clients.has(name))), ...caller };
}
