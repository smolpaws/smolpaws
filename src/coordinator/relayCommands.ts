/** Commands are recognized only by trusted channel ingress, before history/media formatting. */
export interface RelayCommand { kind: 'condense' }
export type CommandResult = 'succeeded' | 'rejected' | 'unknown';
export interface CommandRecord { command: RelayCommand; status: 'pending' | 'attempted' | CommandResult }
export const CONDENSE_REQUEST_TIMEOUT_MS = 180_000;

export function parseRelayCommand(text: string): RelayCommand | undefined {
  return text.trim() === '/condense' ? { kind: 'condense' } : undefined;
}

export function commandReceipt(result: CommandResult): string {
  switch (result) {
    case 'succeeded': return 'Conversation condensed.';
    case 'rejected': return 'The condensation request could not be completed. Check that a condenser profile is configured before trying /condense again.';
    case 'unknown': return 'The condensation outcome is unconfirmed. I will not retry it automatically. You can continue chatting, or send /condense again for a new attempt.';
  }
}
