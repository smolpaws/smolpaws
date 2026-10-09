/** Pure policy: model assessments never authorize a restart. */
export type Status = 'progress' | 'stuck' | 'idle' | 'stopped';
export type Health = 'up' | 'down' | 'unknown';
export type ServiceState = { firstDown?: number; lastRestart?: number };
export const GRACE_MS = 15 * 60_000;
export const COOLDOWN_MS = 60 * 60_000;
export function recovery(previous: ServiceState, health: Health, now: number, paused: boolean) {
  const state = { ...previous };
  // Uncertain evidence breaks the observation chain. Never carry it into a restart.
  if (health !== 'down' || paused || (state.firstDown ?? now) > now) delete state.firstDown;
  else state.firstDown ??= now;
  const restart = health === 'down' && !paused && state.firstDown !== undefined
    && now - state.firstDown > GRACE_MS
    && (state.lastRestart === undefined || now - state.lastRestart >= COOLDOWN_MS);
  return { state, restart };
}
export function activity(execution: string, pending: number, changed: boolean, repeated: boolean): Status {
  if (['error', 'stuck', 'waiting_for_confirmation', 'paused'].includes(execution)) return 'stuck';
  if (['running', 'queued', 'pending'].includes(execution) || pending > 0) {
    return changed && !repeated ? 'progress' : 'stuck';
  }
  if (['idle', 'finished', 'stopped'].includes(execution)) return pending ? 'stuck' : 'idle';
  throw new Error('unrecognized_execution_status');
}
export async function recoverIfEligible(
  previous: ServiceState, now: number,
  deps: { probe: () => Promise<Health>; paused: () => boolean;
    save: (state: ServiceState) => void; start: () => Promise<void> },
): Promise<{ state: ServiceState; health: Health; restarted: boolean }> {
  let health = await deps.probe();
  let decision = recovery(previous, health, now, deps.paused());
  deps.save(decision.state);
  if (!decision.restart) return { state: decision.state, health, restarted: false };
  health = await deps.probe();
  decision = recovery(decision.state, health, now, deps.paused());
  if (!decision.restart) { deps.save(decision.state); return { state: decision.state, health, restarted: false }; }
  // Persist cooldown BEFORE the side effect, including a failed/ambiguous start.
  const state = { ...decision.state, lastRestart: now };
  deps.save(state);
  await deps.start();
  health = await deps.probe();
  if (health === 'up') delete state.firstDown;
  deps.save(state);
  return { state, health, restarted: true };
}
