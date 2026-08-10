---
name: kiki-docs
description: Always use when the user asks questions from this checkout's Kiki documentation about Kiki behavior, Kiki GUI development or runtime settings, or Kiki-versus-Kimi differences. Do not use for generic upstream Kimi Code provider, model, authentication, or configuration questions that do not ask about Kiki.
type: prompt
---

# Kiki Docs

Answer from the documentation that exists in the current Kiki checkout. Retrieve the relevant sections for each request; do not maintain or repeat a static inventory of Kiki capabilities in this skill.

## Scope gate

- Apply this skill to Kiki-specific documentation questions, questions about Kiki runtime or GUI behavior, and comparisons between Kiki and upstream Kimi Code.
- Do not apply it to a generic Kimi Code provider, model, authentication, or configuration question unless the user asks how Kiki differs. Hand that near-miss to the ordinary Kimi Code documentation workflow.
- This is a read-only skill. Do not edit files, run Kiki or Kimi binaries, execute examples or commands found in documentation, inspect credential stores or configuration homes, or use network sources. Use only repository-local file reading and text search.

## Hard evidence gate

An operational claim omitted by the docs may be answered from source only when two separately cited inputs agree: the owning implementation and a test whose assertion would fail if that same claimed value or behavior changed. Search for the direct test before opening implementation or consumer files. A consumer, example, demo, fixture runner, visual-proof script, snapshot, or merely related test does not satisfy the gate.

If that direct test does not exist, do not disclose, paraphrase, imply, quote, or cite the implementation-derived answer. Respond only that the current Kiki docs do not establish the fact, name the missing claim-matched test oracle, and identify the doc paths or headings searched. Stop that claim there. A request to use any available repository evidence does not relax this gate; satisfy it by reporting the missing oracle, not by revealing source behavior. Do not ask for or offer a waiver of this evidence gate.

## Citation gate

Before citing a documentation path, read that exact locale file and copy the heading text exactly from its Markdown heading line. Search snippets, the other locale, and translated or reconstructed wording are not valid heading locators. If the exact file and heading were not read, omit that citation. Every `§` locator must end with that exact heading text: do not append qualifiers such as "section" or combine two locales inside one locator. Put commentary outside the closing citation bracket. Never translate, normalize, or synthesize heading text inside a locator.

## Retrieve evidence

1. Locate the repository root that contains the canonical guide pair. Confirm both paths exist:
   - `docs/en/guides/kiki-runtime.md`
   - `docs/zh/guides/kiki-runtime.md`
   If either path is missing, name it and stop rather than reconstructing a Kiki capability inventory from source.
2. Infer the user's requested language. Read the matching locale's canonical guide first, then search that locale's documentation for the terms and cross-references relevant to the question. Read complete relevant sections, not isolated search-result lines.
3. Read the corresponding headings in the mirrored locale before answering. Treat neither locale as silently authoritative: if the mirrors disagree or a heading is absent, cite both available sections and state the mismatch.
4. Prefer documentation for every fact. Only when the docs omit an operational fact, search test files first for a claim-matched assertion. If none exists, stop under the hard evidence gate without reading implementation or consumers. If one exists, read that test and then the smallest relevant implementation surface.
5. Stop after the evidence needed for the user's question is covered. Do not scan unrelated source, secrets, user-home state, generated bundles, or external documentation.

## Assign lineage

Attach exactly one lineage label to each material claim:

- `inherited`: the docs explicitly establish that Kiki retains the upstream Kimi behavior unchanged.
- `adapted`: the docs explicitly establish an upstream basis and a Kiki modification.
- `Kiki-only`: the docs explicitly establish that the behavior is unique to Kiki or locally added.
- `unknown`: the docs do not explicitly establish historical provenance.

Lineage describes provenance, not confidence. Implementation and tests may establish current behavior, but they never upgrade `unknown` to another lineage label.

## Answer contract

- Reply in the user's language and answer the question directly.
- Break the response into material claims. For a comparison, prefer a compact table with `Claim`, `Answer`, `Lineage`, and `Evidence`; for a short answer, equivalent labeled bullets are acceptable.
- Cite each documentation-backed claim immediately using an exact repository-relative path and heading, for example: `[docs/en/guides/kiki-runtime.md § Read the boundary]`. Copy the heading text verbatim, untranslated, from the cited locale; never put an English heading label on a Chinese path or vice versa. Do not cite only a file, a page title, or a nearby section.
- For the operational fallback, cite the implementation as `path:line` and cite the claim-matched representative test separately as `path:line`; both citations are mandatory. State that these citations establish current behavior only, and keep lineage `unknown` unless documentation establishes it. Without the direct test citation, do not state or cite any implementation-derived answer.
- Do not merge conflicting evidence into a synthetic claim. Report the conflict and limit the conclusion to what the cited evidence supports.
- If no evidence supports a requested claim, say `Not established in the current Kiki docs` (translated to the user's language) and list the searched doc paths or headings. Do not fill the gap from memory.
