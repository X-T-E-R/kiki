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
| CLI and terminal UI | [`apps/kimi-code/AGENTS.md`](apps/kimi-code/AGENTS.md) | [`apps/kimi-code/README.md`](apps/kimi-code/README.md), [`docs/en/reference/command.md`](docs/en/reference/command.md) |
| Kiki GUI runtime client | `apps/kiki-gui/package.json` and adjacent source/tests | [`docs/en/server/local-server.md`](docs/en/server/local-server.md) |
| Embedded persistence | [`packages/minidb/AGENTS.md`](packages/minidb/AGENTS.md) | [`packages/minidb/README.md`](packages/minidb/README.md) |

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
`workspaceNames` lists that nothing generates. When you add or remove a
workspace package, edit both files by hand, then run
`node scripts/check-nix-workspace.mjs` to catch missing and stale entries. The
check reports; it does not generate or repair `flake.nix`.

## Documentation checks

`node scripts/check-docs-governance.mjs` verifies that `docs/en/` and `docs/zh/`
agree in structure and that links resolve. It cannot tell whether the prose is
accurate — that comes from the source and tests behind the change, plus
reviewing how a reader would act on the page.
