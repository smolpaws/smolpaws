/**
 * Pure WhatsApp intake policy: which chats the cat answers in, when a message counts as addressed to it,
 * how a batch of chat messages becomes one prompt, and how a chat maps to a durable relay lane.
 *
 * No I/O here beyond reading already-downloaded media files, so this is fully unit-testable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { LaneDescriptor } from '../../../src/coordinator/types.js';
import { isReadableDocumentMedia, readDocumentText } from '../../../src/document-text.js';
import { MAIN_GROUP_FOLDER, type RegisteredGroup, type WhatsAppConfig } from './config.js';
import type { LedgerMessage } from './ledger.js';

export function isControlScope(folder: string): boolean {
  return folder === MAIN_GROUP_FOLDER;
}

/** The control scope and trigger-free groups respond to ambient messages; others need an @mention. */
export function shouldRespond(
  group: RegisteredGroup,
  content: string,
  triggerPattern: RegExp,
): boolean {
  if (isControlScope(group.folder) || group.triggerFree === true) return true;
  return triggerPattern.test(content);
}

/** One durable lane per registered chat. The cat's own account id keeps lanes distinct across accounts. */
export function laneDescriptorFor(selfJid: string, chatJid: string, group: RegisteredGroup): LaneDescriptor {
  return {
    laneKey: `whatsapp:${selfJid}:${chatJid}`,
    platform: 'whatsapp',
    accountId: selfJid,
    chatId: chatJid,
    threadId: null,
    displayName: `${group.folder} (${group.name})`,
  };
}

/** Per-scope workspace: `groups/<folder>` under the checkout, as the legacy runtime used. */
export function scopeWorkingDir(repoRoot: string, group: RegisteredGroup): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(group.folder)) throw new Error('Invalid scope folder');
  return path.join(repoRoot, 'groups', group.folder);
}

function isImageMedia(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith('image/');
}

function isAudioMedia(mime: string | null | undefined): boolean {
  return !!mime && (mime.startsWith('audio/') || mime.startsWith('application/ogg'));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PromptImage {
  dataUrl: string;
}

export interface BuiltPrompt {
  /** The `<messages>` transcript the agent reads. */
  text: string;
  images: PromptImage[];
  /** Agent-server `content` value: plain text, or a text+image content array when images are attached. */
  content: unknown;
  documentCount: number;
}

function readImageAsDataUrl(mediaPath: string, mediaType: string, maxBytes: number): string | undefined {
  try {
    const buffer = readFileSync(mediaPath);
    if (buffer.length > maxBytes) return undefined;
    return `data:${mediaType};base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * Render the messages the agent has not seen yet as the legacy `<messages>` transcript. Images become
 * inline data URLs (bounded by size), readable documents are extracted, audio is referenced by path.
 */
export async function buildPrompt(
  messages: readonly LedgerMessage[],
  options: { maxImageBytes: number },
): Promise<BuiltPrompt> {
  const lines: string[] = [];
  const images: PromptImage[] = [];
  let documentCount = 0;

  for (const message of messages) {
    const mediaType = message.media_type ?? undefined;
    const imageAttr = message.media_path && isImageMedia(mediaType) ? ' has_image="true"' : '';
    const audioAttr =
      message.media_path && isAudioMedia(mediaType)
        ? ` has_audio="true" audio_path="${escapeXml(message.media_path)}"`
        : '';
    const documentAttr = message.media_path && isReadableDocumentMedia(mediaType) ? ' has_document="true"' : '';
    let attachment = '';
    if (message.media_path && isReadableDocumentMedia(mediaType)) {
      try {
        const document = await readDocumentText(message.media_path, mediaType);
        if (document) {
          documentCount += 1;
          attachment = `\n<attachment name="${escapeXml(document.name)}" type="${escapeXml(mediaType ?? '')}"${document.truncated ? ' truncated="true"' : ''}>${escapeXml(document.text)}</attachment>`;
        }
      } catch {
        attachment = `\n<attachment type="${escapeXml(mediaType ?? '')}" unreadable="true"></attachment>`;
      }
    }
    if (message.media_path && mediaType && isImageMedia(mediaType)) {
      const dataUrl = readImageAsDataUrl(message.media_path, mediaType, options.maxImageBytes);
      if (dataUrl) images.push({ dataUrl });
    }
    lines.push(
      `<message sender="${escapeXml(message.sender_name)}" time="${message.timestamp}"${imageAttr}${audioAttr}${documentAttr}>${escapeXml(message.content)}${attachment}</message>`,
    );
  }

  const text = `<messages>\n${lines.join('\n')}\n</messages>`;
  const content =
    images.length === 0
      ? text
      : [{ type: 'text', text }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))];
  return { text, images, content, documentCount };
}

/** Keep one message per chat: the latest ingested, so a burst of messages becomes one dispatch per chat. */
export function collapseToLatestPerChat(messages: readonly LedgerMessage[]): LedgerMessage[] {
  const latest = new Map<string, LedgerMessage>();
  for (const message of messages) {
    const current = latest.get(message.chat_jid);
    if (current === undefined || message.seq >= current.seq) latest.set(message.chat_jid, message);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** Every lane needs the chat's own working directory; the rest of the defaults are shared. */
export function conversationDefaultsForGroup(
  shared: Record<string, unknown>,
  config: WhatsAppConfig,
  group: RegisteredGroup,
): Record<string, unknown> {
  return {
    ...shared,
    workspace: { kind: 'LocalWorkspace', working_dir: scopeWorkingDir(config.repoRoot, group) },
    tags: { ...((shared.tags as Record<string, string> | undefined) ?? {}), scope: group.folder },
  };
}
