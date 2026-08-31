/**
 * SmolPaws additive tool extensions (EXT-SDK-*).
 *
 * Target-only tools with no upstream counterpart. See docs/TRANSPILE_CONTRACT.md →
 * Additive extensions. Everything under this directory is exempt from the upstream
 * parity oracle but still covered by tests, typecheck, lint, and build.
 */
export * from './send-message.js';
export * from './task-scheduler.js';
