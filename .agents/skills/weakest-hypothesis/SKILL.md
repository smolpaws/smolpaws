---
name: weakest-hypothesis
description: Use when inducing a rule, root cause, or lesson from few examples — reflection steps in self-improvement loops, encoding learnings into memory or prompts, diagnosing from a handful of failure reports, or whenever several explanations fit the evidence and one must be adopted
license: MIT
metadata:
  tags: induction, generalization, reflection, memory, diagnosis, self-improvement
  source: Umaraslam66/ml-superpowers (skills/weakest-hypothesis), MIT
  paper: Bennett, "The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest" (arXiv:2301.12987)
---

# Weakest Hypothesis

> Adopted from [Umaraslam66/ml-superpowers](https://github.com/Umaraslam66/ml-superpowers)
> (MIT). Operationalizes Bennett's paper (arXiv:2301.12987); see the paper digest
> in `papers-please/notes/foundational/optimal-hypothesis-is-the-weakest-not-the-shortest.md`.
> **smolpaws note:** this applies directly to *dreaming* — when promoting a fact
> into `MEMORY.md`, scope it to the weakest sufficient explanation (the learning),
> never the incident (the log entry).

## Overview

When several hypotheses fit your observations, the one most likely to
generalize is not the shortest or most elegant — it's the **weakest**: the one
that commits to the least beyond what the evidence forces.

**Core principle (Bennett's Razor):** *Explanations should be no more specific
than necessary.*

Source: Michael Timothy Bennett, ["The Optimal Choice of Hypothesis Is the
Weakest, Not the Shortest"](https://arxiv.org/abs/2301.12987) (2023). Under a
uniform prior over tasks, weakness maximization is proven necessary and
sufficient to maximize the probability a hypothesis generalizes; minimum
description length is neither. In the paper's binary-arithmetic experiments,
weakest-hypothesis induction generalized at 1.1–5× the rate of shortest.

## Weakness Is Extension, Not Form

Weakness = how little the claim rules out about cases you haven't seen.
It is unrelated to how short the claim reads.

| Statement | Short? | Weak? |
|---|---|---|
| "All things are blue crabs" | yes | no — contradicts nearly everything |
| "The failure involves session state somehow" | no | yes — rules out little |

Never choose between candidate hypotheses by which is shorter to state.

## Procedure

1. **Enumerate** candidate hypotheses that could explain the observations.
2. **Discard the insufficient** — any candidate that fails to account for even
   one observation. Sufficiency first; weakest does not mean vague.
3. **Among the sufficient, adopt the weakest** — the one making the fewest
   claims about unobserved cases. Test each attribute: if deleting it still
   explains every observation, it does no work — delete it.
4. **State what remains open.** Mechanism details the evidence doesn't force
   are hypotheses to discriminate next, not parts of the adopted explanation.

## Where This Bites Agents

**Reflection / lesson encoding.** Scope the lesson to the weakest explanation
of the failure — not to the incident, not to everything. "Never edit
`dist/bundle.js`" overfits the incident and misses the class. "Never edit
files without asking" is a *strong* hypothesis: it contradicts masses of
future valid behavior. The weakest sufficient explanation — "hand-edits to
generated artifacts get overwritten" — yields the correctly scoped rule.

**Diagnosis from few reports.** Three failures that share Chrome, round-hour
timestamps, and carts over $100 do not put those attributes in the hypothesis.
An attribute earns its place only if removing it breaks sufficiency.

**Commitment strength.** From three observations you may claim "consistent
with", never "if and only if". Direction of evidence, not exhaustive
characterization.

## Caveats

- This governs *which hypothesis to adopt*, not whether to stop gathering
  evidence. When you can cheaply obtain discriminating data, do that instead.
- A self-improvement loop applying this still needs a frozen eval set —
  otherwise it optimizes its own blind spots regardless of hypothesis choice.
- The optimality proof assumes uniformly distributed tasks; with strong domain
  priors, weight them — but the burden is on the prior, not on elegance.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Picking the shortest / most elegant hypothesis | Weakness is extension, not form. Count what it rules out. |
| Lessons that quote the incident (file names, versions, thresholds) | Scope to the weakest explanation of the failure class |
| Over-general rules ("never retry", "always ask first") | Strong hypotheses contradict future valid behavior |
| "if and only if" / "exactly when" from a handful of cases | State what the evidence forces; flag the rest as open |
| Spurious shared attributes baked into the diagnosis | Delete each attribute; keep it only if sufficiency breaks |

## Red Flags

- Your hypothesis names a browser, path, threshold, or time that appears in
  the sample but does no explanatory work
- "iff", "exactly when", "the root cause is definitely" from <10 observations
- A memory-file lesson that would not have fired if the same failure recurred
  under a different filename
- Preferring a hypothesis because it is shorter or reads cleaner
