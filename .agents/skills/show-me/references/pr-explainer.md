# pr-explainer — make sense of a change

**Situation:** the reader already understands the repo; now a PR / diff / branch /
uncommitted edit needs explaining. Produce a self-contained HTML report whose center of
gravity is the **before → after core difference** of the affected logic — not a redraw of
the end state, and not the raw diff. Diffs stay collapsed; the picture and the delta lead.

Build per [`html-craft.md`](html-craft.md). This file is *what to put in it*.

## Workflow

1. **Get the change.**
   ```bash
   gh pr view <n> --json title,body,baseRefName,headRefName,files,additions,deletions
   gh pr diff <n>                          # or: git diff <base>...<head>  /  git diff
   gh repo view --json url                 # for clickable blob links (pin head SHA)
   ```
   Group changed files by module/area. Note the merge base / head SHA for source links.
2. **Read both sides of each logical file.** `git show <base>:<path>` vs head. Capture the
   **function-level** behavioral difference — what the code *did* vs *does now*.
   - new file → no before; one "after" diagram + a line on the role it adds.
   - deleted file → "before" diagram + who/what takes over.
   - edited file → before/after pair, delta highlighted.
3. **Classify each file.** *Logic* change (behavior moved) → draw before/after.
   *Mechanical* change (rename, constant, config, import move) → no diagram, a one-line
   `before → after` row. Don't dilute the signal by drawing mechanical edits.
4. **Find the cross-file story.** If one call chain threads several files, draw a single
   **overview** before/after at the top; per-file cards drill in.
5. **Draw, then collapse the diff.** The reader sees summary + before/after diagram by
   default; the diff is one `<details>` away for verification.

## Report sections

1. **What changed (decision first)** — one paragraph: the intent, net effect, and why
   the reader should care. Put the highest-impact conclusion or risk in a `★` callout,
   with the most important changed `path:line` nearby. Stats (`N files · +A / −D`) are
   context, not the lead. If there's a cross-file flow, the **overview before/after SVG**
   goes here: existing structure in dashed gray, the change in solid accent + orange delta
   (see craft ref's encoding).
2. **Left rail / index** — the changed files grouped by area, each tagged
   (🟢 added · 🔴 removed · ✏️ changed · ⚙️ mechanical) with +/− counts; click to jump.
3. **Per-file cards** — for each logical file:
   - claim-carrying title + one-line summary of how its behavior changed;
   - **before / after** diagrams (side-by-side `.ba`, or one overlaid figure) with real
     symbol names + `file:line`, the changed nodes/edges in orange;
   - the diff in a collapsed `<details>` (HTML-escaped, lightly highlighted).
   For mechanical files: a small `before → after` table, no diagram.
4. **(optional) Risk / follow-ups** — only if grounded in what you read.

## Emphasis

- **The delta is the product.** A reader should answer "what's different and why" from the
  before/after diagrams alone, without opening a single diff. Make the changed path
  visually loud (orange dashed); keep unchanged context muted (dashed gray).
- **Ground to the changed lines.** Node detail lines and card headers link to
  `path:line` at the head SHA (clickable blob URL). Put source links beside the behavior
  claim they prove. One click from "this node changed" to the exact code.
- **Before AND after, always, for logic changes.** Never show only the new state when
  something was replaced — the contrast is the whole point.
- **Mechanical ≠ logic.** Constants/renames/config get a table row, not a flowchart.
- **Don't re-implement GitHub.** If all you'd produce is the file list + raw diff, you've
  added nothing. The value is the synthesized before/after picture grounded to code.
- **No process-first writeup.** The reader does not need a diary of inspected files. They
  need the conclusion, the changed path, the proof, and the verification trail.
