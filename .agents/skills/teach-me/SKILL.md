---
name: teach-me
description: >
  Teach a human a code change deeply — not just "what changed" but enough to be quizzed
  on it. Produces one self-contained interactive HTML page with Background → Intuition →
  Code walkthrough → an interactive multiple-choice Quiz. Use when the user says "teach
  me this PR / diff / change", "quiz me on this", "help me really understand this change",
  "explain this so I learn it", or wants to test their own understanding of a change.
triggers:
- /teach-me
- /quiz-me
license: MIT
metadata:
  tags: teaching, explainer, quiz, diff, pr, learning, html
  source: Geoffrey Litt "explain-diff" (gist a29df1b5), adapted
---

# teach-me — learn a code change well enough to be quizzed on it

Where `/show-me` optimizes for *grasping fast and deciding*, `/teach-me` optimizes for
*learning and verifying you learned*. The output is a single self-contained interactive
HTML page a person reads to genuinely understand a change — and then an interactive quiz
proves whether they did. The quiz is the point: it flips the reader from passive skimming
to active recall.

Use it for a PR, a diff, a branch, or uncommitted edits.

## Explore first

Before writing anything, **broadly explore the surrounding code**, not just the diff. You
can only teach the background well if you understand the system the change lives in. Read
callers, callees, the tests, and any relevant config. Ground claims in real code.

## The four sections (in order)

1. **Background.** Explain the existing system relevant to this change. The reader's prior
   knowledge is unknown, so provide two layers:
   - a **deep background for beginners** — clearly marked as skippable for readers already
     familiar;
   - then a **narrow background** covering exactly the part the change touches.
2. **Intuition.** Explain the *core intuition* for the change — the essence, not the full
   detail. Use concrete examples with small toy data. Use figures and diagrams liberally.
3. **Code.** A high-level walkthrough of the actual changes, grouped and ordered so they
   make sense (by concern, not by file-alphabetical). Link to real symbols + `path:line`.
4. **Quiz.** Five interactive multiple-choice questions that test real understanding of the
   change. Medium difficulty: hard enough that you must understand the substance to answer,
   but **not gotchas or trivia**. On click, tell the reader whether they were right and give
   feedback explaining *why* each option is right or wrong. This is the section that makes
   `/teach-me` different from `/show-me` — do not skip or water it down.

## Writing

- Write with the clarity and flow of **Martin Kleppmann** — engaging, classic style, smooth
  transitions between sections. Lead each section into the next; don't just stack headers.
- Pick a **small number of diagram families** and reuse them throughout, rather than a new
  bespoke visual per point. Useful families:
  - a simplified version of the app UI the user sees, to explain UI changes;
  - a system/data-flow diagram between components — **always include example data** on it.
- Use **callouts** for key concepts, definitions, and important edge cases.
- Concrete over abstract: toy data beats prose describing toy data.

## Format & rendering

One **self-contained interactive HTML file** — inline CSS *and* JavaScript (the quiz needs
JS). One long page with section headers and a **table of contents**; do not use tabs for the
top-level structure. Basic responsive styling so it reads on a phone.

Build on the `/show-me` craft for the look and grounding — read
[`../show-me/references/html-craft.md`](../show-me/references/html-craft.md) for the editorial
light theme, the sticky TOC, callouts, hand-drawn inline SVG, and code grounding (`path:line`,
clickable to a pinned blob URL). Two deltas from that craft, specific to `/teach-me`:

- **JavaScript is expected here** (the interactive quiz), unlike show-me's mostly-static pages.
  Keep it to plain inline JS — no framework, no build, still one openable file.
- **Diagrams may be simple HTML** (styled `<div>`s / lists) as well as inline SVG — teaching
  favours clear, repeated figure families over one-off bespoke art.

### Code blocks — do not let newlines collapse

Use `<pre>` for code blocks. If you style a `<div>` as a code block instead, its CSS **must**
include `white-space: pre` or `pre-wrap`, or the browser collapses every newline into one
line. Before saving, scan each code block in the HTML and confirm the whitespace rule is
present. Never use ASCII-art diagrams — use HTML/SVG.

## Delivery (SmolPaws)

Publish to the `enyst.github.io` GitHub Pages site and hand back the clean
`https://enyst.github.io/<path>` URL — Pages serves the page (and its inline JS) with the
right content-type, so the quiz runs live in the reader's browser. Put teaching pages under
`arch/` (or a `teach/` dir) with a date-or-slug filename. See the "HTML artifact delivery"
convention in the repo `AGENTS.md`. A `$TMPDIR` file + `open` is fine for a quick local look.

> Litt's original writes the file to a global temp path outside the repo, prefixed with the
> date, to keep it out of version control. We instead publish to Pages (public, `.nojekyll`)
> so the reader gets a live clickable link with a working quiz.

## Anti-patterns

- ❌ Explaining only *what* changed without the *why* and the background — that's `/show-me`,
  not teaching.
- ❌ A quiz of trivia or gotchas — questions must test real understanding, with feedback.
- ❌ Skipping the quiz, or making it non-interactive (static Q&A) — the interactivity is what
  forces active recall.
- ❌ A build step or framework — keep it one self-contained HTML file with inline JS.
- ❌ Ungrounded claims — explore the surrounding code and cite real symbols + `path:line`.
- ❌ Code blocks in `<div>`s without `white-space: pre`/`pre-wrap` — the newlines collapse.
