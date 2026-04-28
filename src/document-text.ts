import path from 'node:path';
import mammoth from 'mammoth';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_DOCUMENT_TEXT_CHARS = 20_000;

export interface DocumentTextResult {
  name: string;
  text: string;
  truncated: boolean;
}

export function isReadableDocumentMedia(mime: string | undefined): boolean {
  return mime === DOCX_MIME;
}

function normalizeDocumentText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readDocumentText(
  mediaPath: string,
  mediaType: string | undefined,
): Promise<DocumentTextResult | undefined> {
  if (!isReadableDocumentMedia(mediaType)) {
    return undefined;
  }

  const result = await mammoth.extractRawText({ path: mediaPath });
  const normalized = normalizeDocumentText(result.value);
  if (!normalized) {
    return undefined;
  }

  const truncated = normalized.length > MAX_DOCUMENT_TEXT_CHARS;
  return {
    name: path.basename(mediaPath),
    text: truncated
      ? `${normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n\n[Document text truncated]`
      : normalized,
    truncated,
  };
}
