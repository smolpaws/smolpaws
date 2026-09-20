/** Commands are recognized only by trusted channel ingress, before history/media formatting. */
export interface RelayCommand { kind: 'condense' }
export type CommandResult = 'succeeded' | 'rejected' | 'unknown';
export type CommandRejectionReason = 'agent_controlled_condensation';
export interface CommandRecord { command: RelayCommand; status: 'pending' | 'attempted' | CommandResult }
export const CONDENSE_REQUEST_TIMEOUT_MS = 180_000;

export function parseRelayCommand(text: string): RelayCommand | undefined {
  return text.trim() === '/condense' ? { kind: 'condense' } : undefined;
}

/** Only an explicit, recognized server rejection selects a specialized fixed receipt. */
export function commandRejectionReason(error: unknown): CommandRejectionReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 409 || typeof body !== 'string') return undefined;
  try {
    const response: unknown = JSON.parse(body);
    if (typeof response === 'object' && response !== null && !Array.isArray(response)
      && (response as { code?: unknown }).code === 'agent_controlled_condensation') return 'agent_controlled_condensation';
  } catch { /* Unrecognized response bodies retain the generic receipt. */ }
  return undefined;
}

export function commandReceipt(result: CommandResult, reason?: CommandRejectionReason): string {
  switch (result) {
    case 'succeeded': return 'Conversation condensed.';
    case 'rejected':
      if (reason === 'agent_controlled_condensation') return 'This conversation uses agent-controlled condensation. Ask the agent to save its notes and call condense.';
      return 'The condensation request could not be completed. Check that a condenser profile is configured before trying /condense again.';
    case 'unknown': return 'The condensation outcome is unconfirmed. I will not retry it automatically. You can continue chatting, or send /condense again for a new attempt.';
  }
}
