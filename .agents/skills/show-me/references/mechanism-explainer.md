# mechanism-explainer - explain one tricky code path

**Situation:** the reader is not asking for the whole repo or a diff. They are stuck on
one mechanism: a pipeline, extractor, parser, resolver, scheduler, state machine,
ranking rule, scoring path, cache policy, or other branchy logic. Produce a focused,
self-contained HTML walkthrough that makes the mechanism executable in the reader's
head.

Build per [`html-craft.md`](html-craft.md). This file is *what to put in it*.

## Workflow

1. **Name the mechanism and boundary.** Identify the entry function/command, its
   input type, and its output type. Cut everything outside that boundary unless it
   affects the mechanism's behavior.
2. **Trace the code before drawing.** Read the entrypoint, callees that decide state
   or output, the data types, and the focused tests. Prefer tests that encode edge
   cases over nearby implementation comments.
3. **Separate phases.** If the code first creates candidates and later assigns,
   filters, scores, serializes, or emits them, draw those as separate phases. Do not
   collapse them into one arrow; this is where many explanations become misleading.
4. **Build a tiny worked input.** Create a table with 4-8 rows that exercise the
   important branches. Include at least one negative row: an input that looks relevant
   but does not affect the output.
5. **Walk every row through the branches.** Show the intermediate state after each
   phase: candidate set, map contents, counters, chosen branch, sorted order, emitted
   rows, or skipped rows.
6. **Draw the carrying diagram from the trace.** Use hand SVG for the trace or state
   machine. The diagram should answer "why did this output happen?" not merely "which
   modules were called?"
7. **State the invariants and gotchas.** List the rules that prevent common
   misunderstandings: "X creates candidates; Y is assigned later", "A is a tiebreaker,
   not the primary key", "absence of a keep signal is not a drop", etc.
8. **Validate against tests or a small run.** Run focused tests when available. If
   tests are not runnable, cite the tests or fixtures that support the explanation
   and say what was not executed.
9. **Keep the proof beside the rule.** Each branch rule, invariant, and gotcha should
   link to the implementation or focused test right where it is stated.

## Report sections

1. **One-sentence answer** - "This function turns X into Y by doing A, then B." Put
   the surprising rule, risk, or recommended next read immediately below it if there is one.
2. **Boundary and data contract** - input shape, output shape, entry symbol, key
   types. Link every symbol to code.
3. **Algorithm in plain English** - numbered rules in execution order, with source or
   test links beside the rule. Keep this tighter than prose: one branch or state update
   per bullet.
4. **Worked example trace** - the most important section. Use a table like:

   | Input row | Phase 1 effect | Phase 2 effect | Output |
   |---|---|---|---|
   | reviewer event on A | candidate A | assigned to A | emits v0 |
   | author event on B | ignored for candidates | none | no version |

5. **Carrying diagram** - an SVG trace/state-machine. Use muted boxes for inputs that
   are inspected but do not affect output, accent boxes for candidates/output, and
   orange dashed edges for fallback or surprising branches.
6. **What does not happen** - explicit non-examples. This prevents the reader from
   inferring behavior from names or nearby data that the code never uses. When the confusion
   isn't a stray input but a whole *wrong mental model* the reader likely holds ("I assumed X
   and Y were separate passes"), draw a **misconception-correction** figure (the wrong model
   muted on the left, the real one accent on the right, mapping arrows between — see craft ref)
   instead of just listing non-examples. Only do this for a misreading you've actually seen, not
   a strawman.
7. **Source map** - small table from rule -> symbol/test -> link.
8. **Validation** - focused test command and result, or a clear note that validation
   was not run. Put noisy output in collapsed details; keep the relevant pass/fail result visible.

## Emphasis

- **Worked trace before architecture.** A generic flow diagram is not enough for
  branchy logic. The trace table is usually the product because it lets the reader
  verify the explanation row by row.
- **Do not invent symmetric phases.** If one data kind creates candidates and another
  only gets assigned later, say so directly and draw it separately.
- **Show negative space.** Include rows for ignored roles, missing anchors, empty
  inputs, stale schema, disabled flags, or fallback paths when they explain user
  confusion.
- **Prefer exact variable names.** Use local names such as `first_ts`,
  `has_reviewer`, `candidate`, `resolved_idx`, or `drop_reason` when those names
  carry the algorithm.
- **Tie every rule to a test when possible.** Tests are often the shortest proof of
  edge-case intent.
- **Make non-examples visible.** Ignored inputs, no-op branches, and absent state updates
  are part of the mechanism. Show them where they prevent a likely wrong inference.
