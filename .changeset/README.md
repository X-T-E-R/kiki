# Kiki releases

Kiki publishes desktop installers, standalone CLI binaries, and the `kiki-agent` / `kiki-agent-lite` npm packages from a versioned `kiki-v<version>` tag. A push to `kiki` runs a branch build; it does **not** create a release PR or publish a package. A PR remains an option for a change that needs review, not a required step for every version.

## Prepare a version

1. Make sure the intended code is committed on `kiki` and the relevant build and product checks pass. Draft `.github/release-notes/kiki-<version>.md` for readers; include changed setup steps and known limitations.
2. Run `node apps/kiki-gui/scripts/desktop-version.mjs set <version>` to keep the CLI, GUI, Tauri, Cargo, and `system.yaml` versions together. Update the local `kiki-desktop` entry in `apps/kiki-gui/src-tauri/Cargo.lock`, then run `pnpm --filter @kiki/gui run desktop:version:check` and check that `pnpm install --frozen-lockfile` can use the current lockfile.
3. Commit and push the version and notes to `kiki`. Wait for the branch build to pass before tagging that exact commit `kiki-v<version>`. Do not reuse an existing release tag or overwrite a published release.

`.github/workflows/kiki-desktop-release.yml` builds the tagged source for Windows, Linux, and macOS, validates the CLI and desktop artifacts, signs the Windows updater artifact with the production release key, checks the draft assets, publishes the GitHub Release, and then publishes the npm distributions. A completed branch build or a locally promoted desktop executable is not a published release. If the tag workflow fails, inspect the failed step and repair it before announcing a release; do not replace assets or skip its validation steps.

Documentation deploys independently through `.github/workflows/docs-deploy.yml` when `docs/**` changes on `kiki` or `main`.

## Changesets

Changeset files describe user-visible changes and may help with a reviewed version transition, but they do not trigger a PR on every push. The repository still holds older, unconsumed changesets. Before running `pnpm run version:release` or `pnpm changeset version`, reconcile those entries with versions already shipped: running the command against the entire backlog will consume historical files and generate a misleading changelog and bump. The current Kiki tag release procedure above does not run either command automatically.

For a new user-visible change that needs a changeset, use `pnpm changeset`, select the affected publishable package and the appropriate patch/minor/major level, and commit the generated `.changeset/*.md` beside the code. Tests, internal refactors, and documentation-only changes normally do not need one. Kiki's release notes should state what this version actually ships, even when older changeset records remain.
