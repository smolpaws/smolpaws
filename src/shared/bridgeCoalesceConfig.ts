/**
 * Resolves the burst-coalescing window for bridge adapters.
 *
 * Precedence: explicit per-adapter config > BRIDGE_COALESCE_WINDOW_MS env >
 * built-in default. A value of 0 (or negative) disables coalescing, so rapid
 * messages dispatch immediately as before.
 */

/** Default debounce window when nothing is configured. Long enough to catch a
 * human firing two or three quick messages, short enough not to feel laggy. */
export const DEFAULT_COALESCE_WINDOW_MS = 1200;

export function resolveCoalesceWindowMs(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }

  const raw = env.BRIDGE_COALESCE_WINDOW_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return DEFAULT_COALESCE_WINDOW_MS;
}
