import { fromMarkdown } from 'mdast-util-from-markdown';

export type Provider = 'codex' | 'claude';
type Node = { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const OUTPUT_MARKER = '<!-- github-mention-router:';

function textRanges(body: string, includeQuotes = false): [number, number][] {
  const ranges: [number, number][] = [];
  function walk(node: Node): void {
    if (!includeQuotes && node.type === 'blockquote') return;
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
    }
    node.children?.forEach(walk);
  }
  walk(fromMarkdown(body) as Node);
  return ranges;
}

export function managedMentions(body: string): Provider[] {
  if (body.includes(OUTPUT_MARKER) || body.includes('<!-- smolpaws-github-reply -->')) return [];
  const found = new Set<Provider>();
  for (const [start, end] of textRanges(body)) {
    const text = body.slice(start, end).replace(/https?:\/\/[^\s<>]+/g, '');
    for (const match of text.matchAll(/(?<![\w@/\\-])@(codex|claude)(?![\w-])/gi)) {
      found.add(match[1].toLowerCase() as Provider);
    }
  }
  return (['codex', 'claude'] as const).filter(provider => found.has(provider));
}

// Preserve code and link destinations; neutralize notification handles in prose.
export function neutralizeMentions(body: string): string {
  const positions: number[] = [];
  for (const [start, end] of textRanges(body, true)) {
    for (const match of body.slice(start, end).matchAll(/(?<![\w@/\\-])@[a-z\d][a-z\d_-]*/gi)) {
      positions.push(start + match.index + 1);
    }
  }
  for (const position of positions.sort((a, b) => b - a)) body = body.slice(0, position) + '\u200b' + body.slice(position);
  return body;
}
