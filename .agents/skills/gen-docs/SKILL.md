---
name: gen-docs
description: Update mirrored Kimi Code CLI user guides, configuration, and reference pages. Use when a coherent implementation candidate has confirmed user impact and selected exact non-changelog pages for catch-up. Do not use for release changelog synchronization.
---

# Gen Docs

Update the user-facing behavior views already selected by the documentation semantic owner. This workflow begins after implementation and claim-matched tests establish the behavior; it does not block early coding.

Release changelog curation is a separate post-release workflow owned by `sync-changelog`. Do not read or edit either locale's `release-notes/changelog.md` through this skill.

## Prerequisites

Stop and report the missing input when any of these is absent:

- a coherent candidate boundary and user-impact record from the documentation lifecycle;
- owning implementation plus a claim-matched test for every behavior to document;
- exact affected page paths or an accepted semantic packet that selects them;
- `docs/en/`, `docs/zh/`, `docs/.vitepress/config.ts`, and the documentation directory's governing instructions;
- the `translate-docs` skill for meaning-bearing bilingual synchronization.

## Workflow

1. **Fix scope and evidence.** Read the candidate diff, owning implementation, claim-matched tests, and the selected existing sections. Do not infer behavior from commit messages, PR titles, changesets, or changelog prose.
2. **Confirm reader decisions.** For each selected page, state what the reader needs to act, choose, recover, or verify: supported behavior, prerequisites, defaults, configuration, compatibility, migration, observable limits, and failure recovery where applicable. Skip internal refactors, tests, CI, type-only changes, and build changes with no user decision.
3. **Update the selected source view.** Follow the surrounding page structure and the terminology, typography, example-data, and Public-Facing Content rules owned by the documentation instructions. Weave changes into existing sections instead of creating a feature diary.
4. **Produce and approve the mirror.** Use `translate-docs` to write the corresponding `docs/en/` or `docs/zh/` view. Preserve paths, heading levels, lists, code blocks, identifiers, examples, and link shapes. Translation is meaning-bearing work and must be reviewed before any frozen mechanical placement handoff.
5. **Verify.** Read both locale sections, compare their reader-relevant claims, and run:

   ```bash
   pnpm docs:check-governance
   pnpm -C docs run build
   ```

   Inspect the bounded docs diff. The governance checker proves structure only; the claim-matched tests and semantic review establish behavioral accuracy, while bilingual review establishes translation quality.
6. **Record completion.** Mark the selected `user` views completed, or keep each remaining user view classified as `user` with an accountable owner and a target no later than default-on or public release.

## Rules

- Keep non-changelog pages mirrored under `docs/en/` and `docs/zh/`.
- Update only pages and sections selected by the accepted semantic boundary.
- Use neutral public examples such as `https://api.example.com/v1`, `example.test`, and `YOUR_API_KEY`; do not expose internal endpoints, keys, accounts, or service names.
- Do not edit either changelog page. After a release succeeds, route changelog work to `sync-changelog`, whose upstream source is `apps/kimi-code/CHANGELOG.md`.
- Do not claim that structural checks prove prose accuracy, completeness, lineage, or translation quality.

## Stop conditions

- The candidate, affected user view, behavior evidence, or claim-matched test is missing.
- Source and tests disagree, or the selected page would contradict another canonical view.
- A new page, navigation target, claim, or term requires a semantic decision that the accepted packet did not make.
- The requested work is changelog synchronization or would cross the supplied write scope.
