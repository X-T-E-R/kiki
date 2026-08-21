# Semantic documentation packet

Complete this packet before selecting or editing documentation views. Replace each instruction after the colon with candidate-specific facts; do not leave instructional text in a handoff.

## Candidate and boundary

- Candidate: identify the branch, commit range, or diff that contains the coherent implementation and tests.
- Approaching boundary: name stable reuse, owner handoff, default-on, public release, or the explicit documentation-debt acceptance boundary.
- Documentation impact: choose exclusive `none`, or list every affected category from `generated`, `maintainer`, and `user`.
- Completion: choose `completed` or `deferred`. Impact `none` requires `completed`, and generated impact must be completed in the current candidate.
- Deferred views: for each deferred maintainer or user view, record every applicable category, its exact path and heading, one accountable owner, and a target no later than the earliest applicable boundary: stable reuse or owner handoff for maintainer work, or default-on or public release for user work. A view serving both uses whichever boundary arrives first. State that the field does not apply when completion is `completed`.

## Claims and evidence

Use one row per material reader decision. A claim-matched test must fail if the stated behavior changes.

| Claim | Audience | Lineage | Owning implementation | Claim-matched test | Existing view |
| --- | --- | --- | --- | --- | --- |
| State the behavior or decision a reader needs. | maintainer or user | inherited, adapted, Kiki-only, or unknown | repository path and symbol | repository path and assertion | repository path and exact heading, or state that no view exists |

Evidence from implementation and tests establishes current behavior. Assign `inherited`, `adapted`, or `Kiki-only` only from documentation or accepted product history that explicitly establishes provenance; otherwise use `unknown`.

## Fact home and views

- Canonical fact home: name the single owning code contract, package contract, or generated projection.
- Maintainer views: list exact repository paths and headings that need to act, choose, recover, or verify.
- User views: list exact mirrored `docs/en/` and `docs/zh/` paths and headings, or state why no user decision changes.
- Generated views: list each projection and its owning generator or state that none changed.
- Changelog: state whether post-release `sync-changelog` work will be needed; do not treat it as pre-release user documentation.

## Acceptance

- Content acceptance: state the reader actions, choices, recovery steps, compatibility facts, or observable limits that must be accurate.
- Evidence acceptance: name the focused source/test checks that independently establish each behavioral claim.
- Structural acceptance: name mirror, heading, navigation, relative-link, and generated-projection checks that apply.
- Proof limits: state what the checks do not establish, including semantic completeness or translation quality where applicable.

## Mechanical handoff decision

- Semantic work retained by owner: list claim selection, page selection, lineage, fact-home, and acceptance decisions.
- Frozen mechanical work: list exact copy, insertion, navigation, or link-shape edits that `worker_lite` can apply without judgment, including final approved target-language text, or state that no mechanical handoff is needed.
- Stop conditions: list evidence conflicts, missing paths, or boundary changes that return the packet to the semantic owner.

## Completed example

- Candidate: illustrative diff from `abc1234` through `def5678` adds a tested `--example-mode` command option.
- Approaching boundary: default-on.
- Documentation impact: `user`.
- Completion: `completed`.
- Canonical fact home: `apps/example/src/cli/options.ts` and its parser test.
- User views: `docs/en/reference/example-command.md` and `docs/zh/reference/example-command.md`, under their existing options headings.
- Content acceptance: both views name the option, default, accepted values, and the error users see for an unsupported value.
- Proof limits: parser tests establish accepted and rejected values; they do not establish translation quality.
