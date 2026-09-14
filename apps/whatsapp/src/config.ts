import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** A chat the cat listens to. Mirrors the legacy `data/registered_groups.json` entry shape. */
export interface RegisteredGroup {
  name: string;
  /** Scope id, also the per-scope workspace folder under `groups/`. `main` is the control scope. */
  folder: string;
  trigger: string;
  added_at: string;
  /** Respond to every message in this chat, not only to `@smolpaws` mentions. */
  triggerFree?: boolean;
}

export interface WhatsAppConfig {
  relayDbPath?: string;
  routerStatePath?: string;
  startupPing?: boolean;
  assistantName: string;
  /** Regex matching an explicit mention such as `@smolpaws`. */
  triggerPattern: RegExp;
  /** `~/.smolpaws/whatsapp` — Baileys auth, message ledger, media. */
  whatsappDir: string;
  authDir: string;
  mediaDir: string;
  /** SQLite ledger of chats/messages plus the relay cursor. */
  ledgerPath: string;
  /** `chat JID -> registered group` for the chats the cat may answer in. */
  registeredGroups: Record<string, RegisteredGroup>;
  registeredGroupsPath: string;
  /** Root of the smolpaws checkout: per-scope `groups/<folder>` workspaces live here. */
  repoRoot: string;
  pollIntervalMs: number;
  /** Trailing-text debounce: wait this long after the last message in a chat before dispatching. */
  debounceMs: number;
  maxImageBytes: number;
  logLevel: string;
}

export const MAIN_GROUP_FOLDER = 'main';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function triggerPatternFor(assistantName: string): RegExp {
  return new RegExp(`(^|\\W)@${escapeRegex(assistantName)}\\b`, 'i');
}

export function loadRegisteredGroups(filePath: string): Record<string, RegisteredGroup> {
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, RegisteredGroup>;
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * Registered groups live with the rest of the WhatsApp state under `~/.smolpaws/whatsapp/`. During the
 * move away from the repo-root process the legacy `data/registered_groups.json` in the checkout is still
 * honored when the home copy does not exist yet.
 */
export function resolveRegisteredGroupsPath(
  env: Record<string, string | undefined>,
  whatsappDir: string,
  repoRoot: string,
): string {
  const explicit = env.SMOLPAWS_WHATSAPP_REGISTERED_GROUPS?.trim();
  if (explicit) return path.resolve(explicit);
  const home = path.join(whatsappDir, 'registered_groups.json');
  if (existsSync(home)) return home;
  const legacy = path.join(repoRoot, 'data', 'registered_groups.json');
  return existsSync(legacy) ? legacy : home;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..'),
): WhatsAppConfig {
  const assistantName = env.ASSISTANT_NAME?.trim() || 'smolpaws';
  const homeDir = env.SMOLPAWS_HOME_DIR?.trim() || path.join(env.HOME || homedir(), '.smolpaws');
  const whatsappDir = path.join(homeDir, 'whatsapp');
  const registeredGroupsPath = resolveRegisteredGroupsPath(env, whatsappDir, repoRoot);
  return {
    relayDbPath: path.resolve(env.SMOLPAWS_RELAY_DB_PATH?.trim() || path.join(homeDir, 'coordinator', 'whatsapp-relay-v1.db')),
    routerStatePath: path.resolve(env.SMOLPAWS_WHATSAPP_ROUTER_STATE?.trim() || path.join(repoRoot, 'data', 'router_state.json')),
    startupPing: env.SMOLPAWS_WHATSAPP_STARTUP_PING !== '0',
    assistantName,
    triggerPattern: triggerPatternFor(assistantName),
    whatsappDir,
    authDir: path.join(whatsappDir, 'auth'),
    mediaDir: path.join(whatsappDir, 'media'),
    ledgerPath: path.join(whatsappDir, 'messages.db'),
    registeredGroups: loadRegisteredGroups(registeredGroupsPath),
    registeredGroupsPath,
    repoRoot,
    pollIntervalMs: 2_000,
    debounceMs: 1_500,
    maxImageBytes: 10 * 1024 * 1024,
    logLevel: env.LOG_LEVEL || 'info',
  };
}
