/**
 * Backward-compatible exports for the former Slack coordinator runtime name.
 *
 * New code should import `SlackRelayRuntime` from `relayRuntime.ts`.
 */
export {
  SlackRelayRuntime,
  SlackRelayRuntime as SlackCoordinatorRuntime,
  slackLaneDescriptor,
  slackRelayConversationId,
} from './relayRuntime.js';
export type {
  SlackRelayRuntimeOptions,
  SlackRelayRuntimeOptions as SlackCoordinatorRuntimeOptions,
} from './relayRuntime.js';
