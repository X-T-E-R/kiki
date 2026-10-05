# Kiki releases

Kiki publishes desktop installers, standalone CLI binaries, and the
`kiki-agent` / `kiki-agent-lite` npm packages from a versioned
`kiki-v<version>` tag. A push to `kiki` runs a branch build; it does **not**
create a release PR or publish a package. Open a PR only for a change that
needs review.

## Prepare a version

1. Make sure the intended code is committed on `kiki` and the relevant build
   and product checks pass. Draft `.github/release-notes/kiki-<version>.md` for
   readers; include changed setup steps and known limitations.
2. Run `node apps/kiki-gui/scripts/desktop-version.mjs set <version>` to keep
   the CLI, GUI, Tauri, Cargo, and `system.yaml` versions together. Update the
   local `kiki-desktop` entry in `apps/kiki-gui/src-tauri/Cargo.lock`, then run
   `pnpm --filter @kiki/gui run desktop:version:check` and confirm
   `pnpm install --frozen-lockfile` accepts the current lockfile.
3. Commit and push the version and notes to `kiki`. Wait for the branch build
   to pass, then tag that exact commit `kiki-v<version>`. Never reuse an
   existing release tag or overwrite a published release.

`.github/workflows/kiki-desktop-release.yml` builds the tagged source for
Windows, Linux, and macOS, validates the CLI and desktop artifacts, signs the
Windows updater with the production release key, checks the draft assets,
publishes the GitHub Release, and then publishes the npm packages. A green
branch build or a locally promoted desktop executable is **not** a published
release. If the tag workflow fails, fix the failing step and rerun it — do not
swap assets or skip its validation.

Docs deploy separately through `.github/workflows/docs-deploy.yml` whenever
`docs/**` changes on `kiki` or `main`.

## Changesets

Changeset files record user-visible changes. They do not trigger a PR on
every push, and the repository still holds older unconsumed changesets. Before
running `pnpm run version:release` or `pnpm changeset version`, reconcile those
leftover entries against versions already shipped — running either command
over the whole backlog consumes historical files and produces a misleading
changelog and version bump. The tag procedure above runs neither command.

For a user-visible change that needs a changeset, run `pnpm changeset`, pick
the affected publishable package and bump level, and commit the generated
`.changeset/*.md` beside the code. Tests, internal refactors, and
documentation-only changes normally do not need one. The release notes must
describe what the version actually ships, whether or not older changeset files
remain.
