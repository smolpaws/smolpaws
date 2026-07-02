# HTML Report Format

The architecture review is one self-contained HTML page. **Build it on the `/show-me`
craft — don't reinvent the rendering.** Read
[`../show-me/references/html-craft.md`](../show-me/references/html-craft.md) for the base:
the editorial light-theme CSS system (the `:root` palette, sticky numbered TOC, callouts),
self-containment/offline rules, the hand-drawn inline-SVG technique, and code grounding
(`path:line`, clickable to a pinned blob URL). For delivery, use the SmolPaws convention
below, not html-craft's.

This file only adds the **architecture-review specialization** on top of that craft: the
candidate cards, the badges, the before→after *deepening* semantics, and the vocabulary.

> **Delivery (SmolPaws).** Publish the page to the `enyst.github.io` GitHub Pages site under
> `arch/` and hand back the clean `https://enyst.github.io/arch/<slug>.html` URL — it renders
> directly. See the "HTML artifact delivery" convention in the repo `AGENTS.md`; disregard
> html-craft's `htmlpreview` guidance. A `$TMPDIR` file + `open` is fine for a quick local look.

## What the review page inherits from `html-craft.md`

- **The look and shell** — the light editorial theme, readable width, sticky numbered TOC,
  `.callout` / `.callout.warn` / `.callout.note` styles. Use its `:root` variables; don't
  hardcode a second palette.
- **First screen (15-second orientation).** Eyebrow (`Architecture review`), title that
  states the finding, a one-paragraph mental model, and a `★` key-takeaway callout naming
  the top recommendation — before any candidate detail.
- **Hand-drawn inline SVG for the carrying diagram**, per html-craft's SVG section. Auto-layout
  (Mermaid) is auxiliary only; the before/after that carries the argument is hand-drawn so the
  two states stay aligned and the delta is unmistakable.
- **Code grounding** — every box/claim names a real symbol + `path:line`, clickable to the
  source. (Delivery follows the SmolPaws convention above, not html-craft's.)

## The review-specific layer

### Header

Eyebrow `Architecture review`, repo name, date, and a compact legend for the diagram
vocabulary: solid box = module, dashed line = seam, red = leakage/duplication, thick dark box
= deep module. Then the mental model + `★` top-recommendation callout. No process narration.

### Candidate card

One `<section>` per candidate, with a claim-making heading (e.g. "Collapse the Order intake
pipeline" — not "Candidate 1"). The diagram carries the weight; prose is sparse and uses the
`/codebase-design` glossary exactly.

- **Badge row** — recommendation strength (`Strong`, `Worth exploring`, `Speculative`) plus a
  dependency-category tag (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
  Colour the strength badge with an accent scale (e.g. strong = `--ok`, speculative = `--muted`).
- **Files** — monospaced, each a clickable `path:line` source link (html-craft's `a.src`).
- **Before / After diagram** — the centrepiece hand-SVG. See the deepening patterns below.
- **Problem** — one sentence. What hurts.
- **Solution** — one sentence. What changes.
- **Wins** — bullets, ≤6 words each, in glossary terms ("Tests hit one interface", "Pricing
  stops leaking across the seam", "Delete 4 shallow wrappers").
- **ADR callout** (if applicable) — one line in a `.callout.warn` box.

No paragraphs of explanation. If a diagram needs a paragraph to be understood, redraw it.

### Before → after: the deepening diagram

Follow html-craft's before/after convention (dashed-gray = before/context, solid-accent =
after, a third colour for the change) and pick the pattern that fits the candidate:

- **Boxes-and-arrows** — the workhorse. Before: shallow modules with leakage across a seam
  (dashed red edge). After: one thick-bordered **deep** module (`--fg`/dark fill) with the
  now-internal parts greyed inside it.
- **Mass diagram** (for "interface as wide as implementation") — two rectangles per module,
  interface vs implementation. Before: interface rectangle nearly as tall as implementation
  (shallow). After: interface short, implementation tall (deep).
- **Cross-section** (for layered shallowness) — stacked bands showing the layers a call passes
  through. Before: 6 thin pass-through layers. After: 1 thick band with the consolidated
  responsibility.
- **Call-graph collapse** — before: a tree of calls as nested boxes; after: collapsed into one
  box with the internal calls faded inside.

Mermaid is fine for a quick auxiliary dependency graph, but the carrying before/after is
hand-SVG — Mermaid's auto-layout breaks the side-by-side alignment that makes the delta legible.

### Top recommendation section

One `★` callout / larger card: candidate name, one sentence on why, anchor link to its card.

## Tone

Plain English, concise — but the architectural nouns and verbs come straight from the `/codebase-design` skill. Concision is not an excuse to drift.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullets** name the gain in glossary terms: *"locality: bugs concentrate in one module"*, *"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the wrappers"*. Don't write *"easier to maintain"* or *"cleaner code"* — those terms aren't in the glossary and don't earn their place.

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet, make it a bullet. If a bullet could be cut, cut it. If a term isn't in the `/codebase-design` glossary, reach for one that is before inventing a new one.
