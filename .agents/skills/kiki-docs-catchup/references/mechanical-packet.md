# Mechanical documentation packet

The semantic owner completes and freezes this packet for `worker_lite`. `worker_lite` applies only the listed transformations and stops when judgment is required.

## Frozen inputs

- Semantic packet: give the repository path or immutable handoff identifier.
- Candidate: give the exact branch, commit range, or diff boundary.
- Write allowlist: list every file or directory the executor may change.
- Forbidden scope: list nearby files and actions that remain outside the task.

## Exact mapping

Use one row for each source and destination pair.

| Source path and anchor | Destination path and anchor | Allowed transformation | Required preservation |
| --- | --- | --- | --- |
| Give an exact repository path plus heading, key, or unique neighboring line. | Give an exact repository path plus heading, key, or unique neighboring line. | place frozen source or target-language copy, insert exact text, or apply an exact navigation or link-shape mapping | claims, heading levels, identifiers, examples, order, and links that must not change |

`worker_lite` does not translate, choose affected pages, add claims, classify lineage, change the fact home, or alter this source map.

## Exact content

Include the final snippet for every insertion. When locales differ, include the final approved target-language text rather than a translation instruction. Text in this section is deliverable content, not a suggestion or example.

## Checks

- Focused checks: list the exact commands and the expected observable result.
- Read-back: list each file and section that must be reread after editing.
- Structural check: include `node scripts/check-docs-governance.mjs` when the docs tree, navigation, or skill resources change.
- Diff boundary: require `git diff --` followed by the exact write allowlist.

## Stop conditions

Stop and return to the semantic owner when:

- an anchor, path, or mirror is absent or ambiguous;
- the supplied snippet contradicts current source or tests;
- final approved target-language copy is missing, incomplete, or contradicts the frozen source claim;
- a link or navigation target requires selecting an unlisted page;
- a generated file would need a source or generator change not listed in the allowlist;
- any requested edit falls outside the exact mapping.

## Completed example

- Semantic packet: `docs-work/session-export-semantic.md` from the accepted handoff.
- Candidate: illustrative commit `def5678`.
- Write allowlist: `docs/en/reference/session-export.md`, `docs/zh/reference/session-export.md`.
- Mapping: place the approved English paragraph under `## Export format`; place the separately approved Chinese paragraph under the existing Chinese mirror heading with identifiers unchanged.
- Checks: compare heading-level sequences, resolve relative links, run `node scripts/check-docs-governance.mjs`, and inspect the two-file diff.
- Stop: return if either heading or either approved locale paragraph is absent.
