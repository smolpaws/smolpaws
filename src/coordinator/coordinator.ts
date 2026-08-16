/**
 * Backward-compatible exports for the former Message Work Coordinator name.
 *
 * New code should import `MessageRelay` and `MessageRelayOptions` from `messageRelay.ts`. The old names
 * remain temporarily because other bridges and tests may still consume them while they migrate.
 */
export {
  MessageRelay,
  MessageRelay as MessageWorkCoordinator,
  finalResponseExtractor,
  sendMessageExtractor,
} from './messageRelay.js';
export type {
  MessageRelayOptions,
  MessageRelayOptions as CoordinatorOptions,
} from './messageRelay.js';
