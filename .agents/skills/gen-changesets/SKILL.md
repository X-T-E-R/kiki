---
name: gen-changesets
description: Use when generating changesets in the Kiki repository — deciding whether to write one, which package to list, the bump level, the wording, and the confirmation workflow.
---

# Generate Changesets

The primary user-facing published CLI package in this monorepo is `@kiki/cli` (shipped on npm as `kiki-agent` / `kiki-agent-lite`), alongside published SDK packages such as `@kiki/node-sdk`, `@kiki/plugin-sdk`, `@kiki/klient`, and `@kiki/pi-tui`. Internal engine/server packages (`@kiki/agent-core-v2`, `@kiki/kap-server`, `@kiki/kaos`, `@kiki/oauth`, `@kiki/transcript`, etc.) are not curated for end-user changelogs.

## 1. Whether to Write

Rule of thumb: **if users cannot perceive the change, write no changeset.** A changeset is a user-facing changelog entry, not a shipping gate — internal changes merged to `kiki` ship with the next tagged release anyway, so skipping loses nothing.

Do not write:
- Docs-only or tests-only changes that never enter the shipped artifact.
- Changes internal to core/server packages — architecture, protocols, refactors, config/journal/wire mechanics — unless they fix a bug users care about.
- When you are unsure whether users can perceive a change, ask first.

Do write: user-perceivable new features or behavior changes, and internal-package changes that fix a user-useful bug or change CLI output/behavior (list `@kiki/cli` for those).

## 2. What to Write

Create a short kebab-case file under `.changeset/`:

```markdown
---
"@kiki/cli": patch
---

Fix occasional loss of tool call results in long conversations.
```

Wording:
- One short, user-facing English sentence that states only what changed. Drop trailing clauses that explain the cause, the benefit, or the mechanism.
- New features: say plainly what it is plus one line on how to use it, e.g. `Add the /foo slash command to list active sessions. Run /foo to see them.`
- Experimental features: also state how to enable them (the flag, config key, or env var).
- No file, class, or function names, and no PR numbers. No vague words like refactor, optimize, or improve. No real internal identifiers — use neutral placeholders such as `example.com` or `YOUR_API_KEY`.
- Internal packages' own changelogs (such as the sdk) are not curated for end users — write those entries honestly and technically.
- One logical change per changeset; split unrelated changes into separate files.

## 3. Bump Level

- `patch`: bug fixes, small improvements, configuration additions to existing features — when in doubt, use this.
- `minor`: a real new capability users could not do before (a new slash command, a new subcommand, a new mode).
- `major`: **never write it.** If you think a change qualifies, stop and ask the user; without explicit approval fall back to `minor`, or to `patch` if `minor` is also unclear.

## 4. Which Package

- An internal change enters the CLI bundle and is user-perceivable → list `@kiki/cli`.
- An internal change does not enter the CLI or is not user-perceivable → write nothing; if it is written, list only that internal package.
- Never mix packages ignored in `.changeset/config.json` with non-ignored packages in one frontmatter.
- pi-tui exception: pi-tui-only changes list `@kiki/pi-tui`; if the same change is also visible to CLI users, write a separate CLI changeset (two files, never mixed).

## 5. Workflow

1. Run `git status` / `git diff --name-only` to see which packages actually changed.
2. Apply section 1; if no changeset is needed, stop.
3. Pick the package and the bump, and write the one sentence.
4. Write the sentence yourself and commit it with the change; the requester reviews it when integrating the work. Only a `major` bump needs explicit confirmation before committing (section 3).
5. Do not guess at changes you do not understand: finish the parts that are clear, then list what is unclear and ask whether you may dig into the code.

Before a release (`pnpm run version:release` or `kiki-v<version>` tag prep), review the accumulated `.changeset/` entries and delete non-user-facing or already-shipped ones so historical drafts do not clutter the next release changelog.
