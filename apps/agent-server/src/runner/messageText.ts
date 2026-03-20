import {
  reduceTextContent,
  type Message,
  type TextContent,
} from "@smolpaws/agent-sdk";

export function isTextContentLike(value: unknown): value is TextContent {
  if (!value || typeof value !== "object") return false;
  const record = value as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

export function extractMessageText(content: TextContent[]): string {
  const message: Message = {
    role: "user",
    content,
  };
  return reduceTextContent(message).trim();
}

export function extractTextFromMessageRequest(message?: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { content?: unknown };
  const content = Array.isArray(record.content) ? record.content : [];
  const textContent = content.filter(isTextContentLike);
  if (!textContent.length) return "";
  return extractMessageText(textContent);
}

export function extractExtendedContentText(extendedContent?: unknown): string {
  if (!Array.isArray(extendedContent)) return "";
  const textContent = extendedContent.filter(isTextContentLike);
  if (!textContent.length) return "";
  return extractMessageText(textContent);
}
