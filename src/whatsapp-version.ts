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

function isWhatsAppVersion(value: unknown): value is WAVersion {
  return Array.isArray(value)
    && value.length === 3
    && value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

function formatWhatsAppVersion(value: unknown): string {
  return isWhatsAppVersion(value) ? value.join('.') : 'unknown';
}

/**
 * Prefer WhatsApp Web's live client revision, but fall back to Baileys'
 * upstream revision when WhatsApp's sw.js endpoint is unavailable.
 */
export async function resolveWhatsAppVersion(
  fetchers: VersionFetchers = defaultFetchers,
): Promise<WhatsAppVersionResolution> {
  let webError: unknown;
  try {
    const web = await fetchers.fetchWhatsAppWebVersion();
    if (web?.isLatest && isWhatsAppVersion(web.version)) {
      return { version: web.version, source: 'whatsapp-web' };
    }
    webError = web?.error ?? new Error(
      `WhatsApp Web returned unusable client version ${formatWhatsAppVersion(web?.version)}`,
    );
  } catch (error) {
    webError = error;
  }

  let upstreamError: unknown;
  try {
    const upstream = await fetchers.fetchBaileysVersion();
    if (upstream?.isLatest && isWhatsAppVersion(upstream.version)) {
      return { version: upstream.version, source: 'baileys-upstream' };
    }
    upstreamError = upstream?.error ?? new Error(
      `Baileys upstream returned unusable client version ${formatWhatsAppVersion(upstream?.version)}`,
    );
  } catch (error) {
    upstreamError = error;
  }

  throw new Error('Unable to resolve a current WhatsApp Web client version', {
    cause: new AggregateError(
      [webError, upstreamError],
      'WhatsApp Web and Baileys upstream version lookups failed',
    ),
  });
}
