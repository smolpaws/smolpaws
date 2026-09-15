/**
 * SmolPaws identity/context loader for relay bridges.
 *
 * `docs/smolpaws/*.md` is the canonical, public source of the cat's identity, soul, user notes, tool
 * layout, and memory pointers. The legacy runner injected these files as repo skills; the upstream-shaped
 * agent-server does not know about SmolPaws, so each bridge attaches them to a new conversation through the
 * upstream `agent_launch_additions.system_message_suffix_append` request field.
 *
 * The rendering mirrors the SDK's own `<REPO_CONTEXT>` framing so the model sees one consistent style.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files under docs/smolpaws that are not conversation context (heartbeat checklist, directory readme). */
const EXCLUDED_CONTEXT_FILES: ReadonlySet<string> = new Set(['README.md', 'HEARTBEAT.md']);
// Pinned upstream AgentLaunchAdditions.system_message_suffix_append limit.
const MAX_CONTEXT_SUFFIX_LENGTH = 32768;

export interface SmolpawsContextOptions {
  /** Repository root that contains docs/smolpaws. Defaults to this checkout. */
  readonly repoRoot?: string;
  /** Extra absolute markdown paths appended after the repo docs (for example private memory). */
  readonly extraFiles?: readonly string[];
}

export interface SmolpawsContextDoc {
  readonly name: string;
  readonly path: string;
  readonly content: string;
}

/** The smolpaws repository root, derived from this module's location so it does not depend on cwd. */
export function smolpawsRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Load the context documents in a stable order (alphabetical by file name, then extras as given). */
export function loadSmolpawsContextDocs(options: SmolpawsContextOptions = {}): SmolpawsContextDoc[] {
  const repoRoot = path.resolve(options.repoRoot ?? smolpawsRepoRoot());
  const docsDir = path.join(repoRoot, 'docs', 'smolpaws');
  const docs: SmolpawsContextDoc[] = [];

  if (isDirectory(docsDir)) {
    const names = readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !EXCLUDED_CONTEXT_FILES.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const filePath = path.join(docsDir, name);
      const content = readFileSync(filePath, 'utf8').trim();
      if (content.length === 0) continue;
      docs.push({ name: `docs/smolpaws/${name}`, path: filePath, content });
    }
  }

  for (const extra of options.extraFiles ?? []) {
    if (!existsSync(extra)) continue;
    const content = readFileSync(extra, 'utf8').trim();
    if (content.length === 0) continue;
    docs.push({ name: path.basename(extra), path: extra, content });
  }

  return docs;
}

/**
 * Render the context docs as one system-message suffix, or null when there is nothing to attach.
 * The `ingress` label tells the cat which front door this conversation came through.
 */
export function renderSmolpawsContextSuffix(
  docs: readonly SmolpawsContextDoc[],
  ingress?: string,
): string | null {
  if (docs.length === 0) return null;
  const blocks = docs.map((doc) => `[BEGIN context from ${doc.name}]\n${doc.content}\n[END context]`);
  const header = ingress === undefined
    ? ''
    : `This conversation arrived through the ${ingress} bridge. Replies are delivered back to that channel.\n\n`;
  const render = () => `<SMOLPAWS_CONTEXT>\n${header}${blocks.join('\n\n')}\n</SMOLPAWS_CONTEXT>`;
  let suffix = render();
  // Keep complete documents, not arbitrary truncated fragments. Large memory files stay on disk
  // and remain explicit startup context; the normal small identity documents remain inline.
  const largestFirst = docs.map((doc, index) => ({ doc, index }))
    .sort((a, b) => b.doc.content.length - a.doc.content.length);
  for (const { doc, index } of largestFirst) {
    if (suffix.length <= MAX_CONTEXT_SUFFIX_LENGTH) break;
    const reference = `[BEGIN context from ${doc.name}]\nRead this file before answering: ${JSON.stringify(doc.path)}. Its full content is on disk because it exceeds the inline context budget.\n[END context]`;
    if (reference.length >= blocks[index]!.length) continue;
    blocks[index] = reference;
    suffix = render();
  }
  if (suffix.length > MAX_CONTEXT_SUFFIX_LENGTH) throw new Error('SmolPaws context references exceed the server launch-context limit');
  return suffix;
}

/** One-call convenience used by bridge entrypoints. */
export function loadSmolpawsContextSuffix(options: SmolpawsContextOptions & { readonly ingress?: string } = {}): string | null {
  return renderSmolpawsContextSuffix(loadSmolpawsContextDocs(options), options.ingress);
}
