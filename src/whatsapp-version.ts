import {
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  type WAVersion,
} from '@whiskeysockets/baileys';

type VersionResult = {
  version: WAVersion;
  isLatest: boolean;
  error?: unknown;
};

type VersionFetchers = {
  fetchWhatsAppWebVersion: () => Promise<VersionResult>;
  fetchBaileysVersion: () => Promise<VersionResult>;
};

export type WhatsAppVersionResolution = {
  version: WAVersion;
  source: 'whatsapp-web' | 'baileys-upstream';
};

const defaultFetchers: VersionFetchers = {
  fetchWhatsAppWebVersion: fetchLatestWaWebVersion,
  fetchBaileysVersion: fetchLatestBaileysVersion,
};

/**
 * Prefer WhatsApp Web's live client revision, but fall back to Baileys'
 * upstream revision when WhatsApp's sw.js endpoint is unavailable.
 */
export async function resolveWhatsAppVersion(
  fetchers: VersionFetchers = defaultFetchers,
): Promise<WhatsAppVersionResolution> {
  const web = await fetchers.fetchWhatsAppWebVersion();
  if (web.isLatest) {
    return { version: web.version, source: 'whatsapp-web' };
  }

  const upstream = await fetchers.fetchBaileysVersion();
  if (upstream.isLatest) {
    return { version: upstream.version, source: 'baileys-upstream' };
  }

  throw new Error('Unable to resolve a current WhatsApp Web client version', {
    cause: upstream.error ?? web.error,
  });
}
