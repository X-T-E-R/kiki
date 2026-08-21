---
name: kiki-docs-catchup
description: Catch Kiki maintainer or user documentation up after a coherent implementation candidate, or execute an explicit documentation-debt task. Use when behavior is already implemented and tested and the task is to classify documentation impact, establish source and test evidence, choose canonical paths, update bilingual views, or prepare exact mechanical documentation wiring. Do not use during ordinary early implementation or for read-only repository questions.
metadata:
  short-description: Catch documentation up after implementation
---

# Kiki docs catch-up

Bring documentation up to the boundary that the implementation candidate is approaching. This workflow starts after coherent behavior and tests exist, or when the user explicitly assigns documentation debt; it does not delay exploration or early coding.

## Trigger matrix

| Situation | Trigger | Result |
| --- | --- | --- |
| A tested candidate is preparing for stable reuse, owner handoff, default-on, or public release | Yes | Classify impact and update the due views |
| An explicit task names existing documentation debt | Yes | Reconstruct evidence, then update the bounded views |
| `worker_lite` needs exact, already-decided copy, insertion, navigation, or link-shape work | Yes | Validate the semantic packet, then freeze a mechanical packet |
| Feature implementation is still exploratory or tests do not establish the claimed behavior | No | Continue implementation and testing |
| A user asks what current Kiki docs say | No | Use the read-only `kiki-docs` skill |

Read [`references/trigger-matrix.md`](references/trigger-matrix.md) when the boundary is ambiguous or several documentation tools appear applicable.

## Workflow

1. **Fix the candidate boundary.** Name the branch, commit range, or diff and the approaching boundary. Do not broaden the implementation or invent release timing.
2. **Gather independent evidence.** For each material claim, read the owning implementation and a claim-matched test whose assertion would fail if the behavior changed. Read existing owner and audience views only after the behavior evidence is clear.
3. **Classify impact and completion separately.** Choose exclusive `none`, or select every affected category from `generated`, `maintainer`, and `user`. Then record `completed` or `deferred`; `none` pairs with `completed`. Generated work is never deferrable. Every deferred maintainer or user entry retains all applicable categories and its exact view, one accountable owner, and a target no later than the earliest applicable boundary: stable reuse or owner handoff for maintainer work, or default-on or public release for user work.
4. **Assign lineage.** Mark each claim `inherited`, `adapted`, `Kiki-only`, or `unknown`. Documentation or accepted product history establishes lineage; current code and tests establish behavior but do not infer provenance.
5. **Choose one fact home and its views.** Prefer the owning package contract or generated projection. Update links and audience views instead of repeating package inventories. Use [`references/semantic-packet.md`](references/semantic-packet.md) to record claims, audiences, lineage, evidence, canonical paths, and acceptance before editing.
6. **Apply the due work.** Keep generated contracts exact in the current candidate. Complete maintainer views before stable reuse or owner handoff. Complete both `docs/en/` and `docs/zh/` views before default-on or public release. Follow the documentation directory's governing instructions and the runtime Public-Facing Content rules for reader-facing prose.
7. **Delegate only frozen mechanics to `worker_lite`.** The semantic owner writes and approves all meaning-bearing prose, including final target-language copy, directly or through the existing `translate-docs` workflow before filling [`references/mechanical-packet.md`](references/mechanical-packet.md). `worker_lite` may only place frozen copy, insert exact snippets, and apply exact navigation or link-shape mappings. It receives no authority to translate, invent claims, select pages, classify lineage, or change source maps.
8. **Verify and report.** Run the smallest claim-matched checks plus the repository's `pnpm docs:check-governance` command. Inspect both locale views and every generated projection changed. Report proof limits: the structural checker does not establish semantic correctness.

For post-release changelog curation, hand off to `sync-changelog`. For translation of an already-approved page and structure, use `translate-docs` within the frozen semantic boundary.

## Stop conditions

- The implementation candidate or its claim-matched test is missing.
- The due boundary cannot be determined and different answers would change which audience must be complete.
- Source and tests disagree, or existing views assert conflicting behavior.
- A mechanical request requires choosing claims, pages, lineage, or mappings that the semantic packet did not freeze.
- A mechanical packet omits the final approved target-language copy that `worker_lite` would place.
- Work would cross the supplied write scope, expose non-public values, or publish externally.

Stop with the missing evidence or decision and the smallest next handoff. Do not fill a semantic gap with polished prose.
