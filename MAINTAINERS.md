# Kiki maintainer portal

Start here to find the owner for an area, then follow that owner's own
instructions. This page is a router: it holds no package contracts.

## Find the owner

| Area | Instructions | Reader-facing docs |
| --- | --- | --- |
| Agent engine, scopes, services, features | [`packages/agent-core-v2/AGENTS.md`](packages/agent-core-v2/AGENTS.md) | [`packages/agent-core-v2/docs/features.md`](packages/agent-core-v2/docs/features.md), [`packages/agent-core-v2/docs/service-design.md`](packages/agent-core-v2/docs/service-design.md) |
| kap-server REST, WebSocket, and debug surfaces | [`packages/kap-server/AGENTS.md`](packages/kap-server/AGENTS.md) | [`packages/kap-server/README.md`](packages/kap-server/README.md), [`docs/en/server/rest-api.md`](docs/en/server/rest-api.md) |
| Klient contracts and transports | [`packages/klient/AGENTS.md`](packages/klient/AGENTS.md) | [`packages/klient/README.md`](packages/klient/README.md) |
| Transcript contract and projections | [`packages/transcript/AGENTS.md`](packages/transcript/AGENTS.md) | [`docs/en/guides/sessions.md`](docs/en/guides/sessions.md) |
| Engine-to-transcript live bindings | [`packages/transcript-live/AGENTS.md`](packages/transcript-live/AGENTS.md) | [`packages/transcript/AGENTS.md`](packages/transcript/AGENTS.md) |
| Shared framework-free client session state | [`packages/session-core/AGENTS.md`](packages/session-core/AGENTS.md) | [`docs/en/guides/settings.md`](docs/en/guides/settings.md) |
| Vendored terminal rendering library | [`packages/pi-tui/AGENTS.md`](packages/pi-tui/AGENTS.md) | [`packages/pi-tui/README.md`](packages/pi-tui/README.md) |
| CLI and terminal UI | [`apps/kimi-code/AGENTS.md`](apps/kimi-code/AGENTS.md) | [`apps/kimi-code/README.md`](apps/kimi-code/README.md), [`docs/en/reference/command.md`](docs/en/reference/command.md) |
| Kiki GUI (Web, Desktop, Mobile remote shell) | [`apps/kiki-gui/AGENTS.md`](apps/kiki-gui/AGENTS.md) | [`docs/en/server/local-server.md`](docs/en/server/local-server.md) |
| Android APK builds, signing, and local host | `apps/kiki-android` and `apps/kiki-gui/mobile/scripts/` ([release workflow](.github/workflows/kiki-desktop-release.yml)) | [Build and verify APKs](docs/maintainer/android-release.md), [install Android](docs/en/getting-started/installation.md#install-the-android-app) |
| Documentation site and catch-up lifecycle | [`docs/AGENTS.md`](docs/AGENTS.md) | [`docs/en/index.md`](docs/en/index.md) |
| Upstream synchronization policy | [`docs/maintainer/upstream-sync.md`](docs/maintainer/upstream-sync.md) | [`docs/maintainer/upstream-merge-log.md`](docs/maintainer/upstream-merge-log.md) |
| Cloud CI runners | [`.github/workflows/kiki-cloud-ci.yml`](.github/workflows/kiki-cloud-ci.yml) | [`docs/maintainer/cloud-ci.md`](docs/maintainer/cloud-ci.md) |

Adding a new area? Add its row here and point at the new owner rather than
writing the entry inline.

## Generated contracts

These checked-in views must match their generators exactly and are due in the
same change as their sources:

| Projection | Generator |
| --- | --- |
| `packages/agent-core-v2/docs/config-manifest.toml` | `packages/agent-core-v2/scripts/gen-config-manifest.mts` |
| `packages/agent-core-v2/docs/state-manifest.d.ts` | `packages/agent-core-v2/scripts/gen-state-manifest.mts` |
| `packages/agent-core-v2/docs/wire-manifest.d.ts` | `packages/agent-core-v2/scripts/gen-wire-manifest.mts` |

Read the owning package's `AGENTS.md` before regenerating; the command and
source boundary belong there.

## Manually synchronized contract

[`pnpm-workspace.yaml`](pnpm-workspace.yaml) decides workspace membership, but
[`flake.nix`](flake.nix) repeats it as hardcoded `workspacePaths` and
`workspaceNames` lists and [`AGENTS.md`](AGENTS.md) maintains `## Workspace Map`.
When you add or remove a workspace package, update all three, then run
`pnpm run check:meta` (`scripts/check-repo-meta.mjs` includes
`scripts/check-nix-workspace.mjs`).

## Governance checks

`pnpm run check:meta` runs `node scripts/check-repo-meta.mjs` (workspace parity,
package dependency boundaries, meta-doc links, retired scopes, word budgets, and
scratch hygiene) and `node scripts/check-docs-governance.mjs` (`docs/en/` and
`docs/zh/` structural parity and link resolution). Neither check assesses prose
accuracy — verify behavior from source and tests.
