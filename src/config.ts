import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'smolpaws';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths (host persistence + container mounts)
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

export const SMOLPAWS_HOME = path.join(HOME_DIR, '.smolpaws');
export const WHATSAPP_DIR = path.join(SMOLPAWS_HOME, 'whatsapp');

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'smolpaws', 'mount-allowlist.json');

// Host-only WhatsApp persistence (not mounted into containers)
// Stored under ~/.smolpaws/whatsapp

export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(`(^|\\W)@${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
