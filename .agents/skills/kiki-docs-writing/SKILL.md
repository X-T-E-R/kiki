---
name: kiki-docs-writing
description: Write, rewrite, or audit Kiki user-facing documentation pages (docs/en, docs/zh) so they stay user-facing, verifiable, and navigable. Use when creating new docs pages, restructuring a docs section, fixing reader-reported confusion, or auditing pages for internal-content leaks, contradictions, jargon, and entry-point failures. Not for the post-implementation catch-up process (use kiki-docs-catchup) or read-only docs Q&A (use kiki-docs).
metadata:
  short-description: Write and audit user-facing docs pages
---

# Kiki docs writing

The writing standard for Kiki's public documentation site (`docs/en`, `docs/zh`, VitePress). Editorial conventions (term table, typography, callouts, page structure) live in `docs/AGENTS.md` and are NOT repeated here — read them before editing. This skill adds the failure modes that actually shipped, and the audit workflow that catches them.

## The four failure modes (learned from a full-site audit)

1. **Internal content leaks.** Package paths (`packages/agent-core-v2`), source files (`src/cli/commands.ts`), internal system names (`nb-search`, `kap-server`, `kaos`, Own Work, Assay), removed-feature histories ("the removed v1 adapter", "the retired X"), completion tracking ("implements 10/12 handlers"), upstream sync workflow, and version badges copied from a marketplace. Test every sentence: **can a user do something with this information?** If not, cut it or move it to `docs/maintainer/` (excluded from the site via `srcExclude`). Carve-out: deprecated or removed names that still drive a user decision stay — the migration path off a deprecated config key, a legacy path that is still read, a historical variable name that remains effective. The rule kills obituaries and refactor trivia, not migration guidance.
2. **Missing concept layer.** A section jumps into mechanism before the reader has a mental model. Every section whose pages share one underlying concept (e.g. profiles) needs a concept page FIRST in reading order: what it is, where it lives, when it takes effect, and a mechanism map ("want to change X → use mechanism Y"). Reference pages link back to it; concept pages never repeat field tables.
3. **Unverified claims that contradict reality or each other.** Flag combinations, env-var semantics, endpoint lists, default values. Every behavioral claim must be checked against the owning code before writing — docs review reports are leads, not truth; readers can be wrong, and code is the only source of truth.
4. **Entry-point failures.** Page titles a newcomer can't decode ("convergence roadmap"), pages addressed to the wrong audience in the wrong section (migration content inside Getting Started without an audience marker), maintainer ADRs on the public site, and pages that open with editor-speak ("this page introduces no new behavior") instead of telling the reader what they can do here.

## Writing checklist (per page)

- **Audience gate**: does the opening say who this page is for and what they can do after reading? Pages only relevant to existing/legacy users must say so in the first sentence ("Skip this page if you installed Kiki fresh").
- **Map before detail**: first sentence of every page and major section states what it covers and how it relates to what came before.
- **Jargon gloss**: first use of any term a non-technical AI user wouldn't know (daemon, token, lease, sidecar, SemVer, wire) gets a one-line plain-language parenthetical. Afterwards use the term normally.
- **Verify against code**: flags in `apps/kimi-code/src/cli/`, env vars and config keys via Grep over `apps/` + `packages/`, UI labels in `apps/kiki-gui/src/` locale files. Never copy a claim from another docs page without verification — contradictions breed that way.
- **Internal names**: user docs say "Kiki local server", not `kap-server`; "built-in search and fetch module", not `nb-search`; no package paths, no source-file links, no refactor obituaries. Historical filenames that are real (e.g. a log file name) keep the fact plus a "(historical name)" gloss.
- **Code blocks**: always language-tagged (`sh`, `toml`, `json`, `ts`), and every example must work when copy-pasted (placeholders like `YOUR_API_KEY`, no invented flags).
- **Mirror discipline**: zh and en are edited together, same structure. If you cannot finish both, stop and say so — do not ship one locale.
- **Content completeness**: keep everything unless you can name the reason for removal (pure implementation detail, covered more completely elsewhere and linked, or outdated). List every removal in your report; never silently drop.
- **Link forward at first mention**: a concept with its own page is linked on first mention, with anchors (`#section`) preferred over page tops.

## Restructuring checklist (moving/renaming pages)

1. Grep for inbound links across `docs/` before moving anything.
2. `git mv` the page (both locales), rework content if needed.
3. Wire the new location into `docs/.vitepress/config.ts` nav + sidebar for BOTH locales; entry-point pages go first in their group.
4. Add the old URL to `docs/.vitepress/legacy-routes.ts` (`legacyMoves`) so published links keep working.
5. Update `docs/AGENTS.md` structure section to match the new IA.
6. Build and test with the **same** base: `cd docs && VITEPRESS_BASE=<base> npm run build && VITEPRESS_BASE=<base> npm run test:ia` (on Git Bash/Windows also `export MSYS_NO_PATHCONV=1`, or `/kiki/` gets converted to a Windows path and tests fail spuriously).

## Audit workflow (multi-persona forward reading)

For a whole-section quality pass, don't read pages yourself top to bottom once — dispatch 2–4 read-only agents as **personas** (e.g. non-technical new user zh path; developer en path; integrator), each reading an assigned page set front to back and reporting: internal leaks, entry failures, jargon, contradictions (with quotes and file paths), and where their journey stalls. Personas must NOT edit. Then:

1. Merge findings; dedupe; mark each as fact-fix (verify in code first), structure-fix, or style-fix.
2. Dispatch fixes by disjoint file ownership; keep nav/config/redirect files with the coordinator.
3. Rebuild, run `test:ia`, and re-check the pages that moved.

## Anti-patterns

- Fixing docs from a review report without opening the code — reports exaggerate.
- Deleting "internal" content that is the only place a user-facing fact lives — merge the fact into a public page first, then move the page.
- Concept pages that duplicate the reference page's field tables (drift source) instead of linking to them.
- Sidebars ordered by mechanism maturity instead of reader need (advanced override pages before the create-your-first-X pages).
- Changelog-style edits in generated pages (changelog is synced from the CLI package's CHANGELOG; fix the source or the sync skill).
