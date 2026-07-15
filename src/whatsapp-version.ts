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
  let webError: unknown;
  try {
    const web = await fetchers.fetchWhatsAppWebVersion();
    if (web?.isLatest) {
      return { version: web.version, source: 'whatsapp-web' };
    }
    webError = web?.error ?? new Error(
      `WhatsApp Web returned non-current client version ${web?.version?.join('.') ?? 'unknown'}`,
    );
  } catch (error) {
    webError = error;
  }

  let upstreamError: unknown;
  try {
    const upstream = await fetchers.fetchBaileysVersion();
    if (upstream?.isLatest) {
      return { version: upstream.version, source: 'baileys-upstream' };
    }
    upstreamError = upstream?.error ?? new Error(
      `Baileys upstream returned non-current client version ${upstream?.version?.join('.') ?? 'unknown'}`,
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
