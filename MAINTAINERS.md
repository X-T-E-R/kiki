# Kiki maintainer portal

This is the repository entry point for maintainers. It is not part of the VitePress source tree and is not published with the user documentation by default. Behavior remains owned by code and claim-matched tests; this page routes to fact homes instead of copying package contracts.

## Documentation catch-up

Functionality is implemented and tested first. Once a coherent candidate exists, follow the [documentation lifecycle](docs/AGENTS.md#documentation-lifecycle) and classify its impact. Use the [`kiki-docs-catchup` skill](.agents/skills/kiki-docs-catchup/SKILL.md) to turn source and test evidence into maintainer or user views without making prose an early-coding gate.

The same fact may have several views, but it has one canonical home:

- implementation and claim-matched tests own current behavior;
- an owning package guide or `AGENTS.md` owns stable maintainer instructions;
- checked-in generated contracts are exact projections of their named generators;
- `docs/en/` and `docs/zh/` are audience views governed by [`docs/AGENTS.md`](docs/AGENTS.md);
- [`apps/kimi-code/CHANGELOG.md`](apps/kimi-code/CHANGELOG.md) feeds post-release curation through [`sync-changelog`](.agents/skills/sync-changelog/SKILL.md).

When a view disagrees with its fact home, fix the view or regenerate the projection. Do not create another summary as an arbitrator.

## Deep feature entry points

Start at the owner for the feature, then follow its links to implementation and tests:

| Area | Maintainer entry | Stable or user-facing view |
| --- | --- | --- |
| Agent engine v1 | [`packages/agent-core/AGENTS.md`](packages/agent-core/AGENTS.md) | [`packages/agent-core/README.md`](packages/agent-core/README.md) |
| Agent engine v2, scopes, services, features | [`packages/agent-core-v2/AGENTS.md`](packages/agent-core-v2/AGENTS.md) | [`packages/agent-core-v2/docs/features.md`](packages/agent-core-v2/docs/features.md), [`packages/agent-core-v2/docs/service-design.md`](packages/agent-core-v2/docs/service-design.md) |
| kap-server REST, WebSocket, and debug surfaces | [`packages/kap-server/AGENTS.md`](packages/kap-server/AGENTS.md) | [`packages/kap-server/README.md`](packages/kap-server/README.md), [`docs/en/reference/server-api.md`](docs/en/reference/server-api.md) |
| Klient contracts and transports | [`packages/klient/AGENTS.md`](packages/klient/AGENTS.md) | [`packages/klient/README.md`](packages/klient/README.md) |
| Transcript contract and projections | [`packages/transcript/AGENTS.md`](packages/transcript/AGENTS.md) | [`docs/en/guides/sessions.md`](docs/en/guides/sessions.md) |
| CLI and terminal UI | [`apps/kimi-code/AGENTS.md`](apps/kimi-code/AGENTS.md) | [`apps/kimi-code/README.md`](apps/kimi-code/README.md), [`docs/en/reference/kimi-command.md`](docs/en/reference/kimi-command.md) |
| Kiki GUI runtime client | [`apps/kiki-gui/package.json`](apps/kiki-gui/package.json) and adjacent source/tests | [`docs/en/guides/kiki-runtime.md`](docs/en/guides/kiki-runtime.md), [`apps/kiki-gui/docs/server-heartbeat.md`](apps/kiki-gui/docs/server-heartbeat.md) |
| Inspector and debug RPC UI | [`apps/kimi-inspect/AGENTS.md`](apps/kimi-inspect/AGENTS.md) | [`apps/kimi-inspect/README.md`](apps/kimi-inspect/README.md) |
| Embedded persistence | [`packages/minidb/AGENTS.md`](packages/minidb/AGENTS.md) | [`packages/minidb/README.md`](packages/minidb/README.md) |

For a new deep feature, add or update the nearest owner entry rather than growing this table into a second architecture document.

## Generated contracts

These checked-in views must match their generators exactly and are due in the same candidate as their sources:

| Projection | Generator |
| --- | --- |
| [`packages/agent-core-v2/docs/config-manifest.toml`](packages/agent-core-v2/docs/config-manifest.toml) | [`packages/agent-core-v2/scripts/gen-config-manifest.mts`](packages/agent-core-v2/scripts/gen-config-manifest.mts) |
| [`packages/agent-core-v2/docs/state-manifest.d.ts`](packages/agent-core-v2/docs/state-manifest.d.ts) | [`packages/agent-core-v2/scripts/gen-state-manifest.mts`](packages/agent-core-v2/scripts/gen-state-manifest.mts) |
| [`packages/agent-core-v2/docs/wire-manifest.d.ts`](packages/agent-core-v2/docs/wire-manifest.d.ts) | [`packages/agent-core-v2/scripts/gen-wire-manifest.mts`](packages/agent-core-v2/scripts/gen-wire-manifest.mts) |

Read the owning package instructions before regenerating a contract; the command and source boundary belong there.

## Manually synchronized checked contracts

[`pnpm-workspace.yaml`](pnpm-workspace.yaml) is the source of truth for workspace membership. When a workspace package is added or removed, update the hardcoded `workspacePaths` and `workspaceNames` lists in [`flake.nix`](flake.nix) by hand in the same candidate, then run:

```sh
node scripts/check-nix-workspace.mjs
```

This check detects missing and stale entries; it does not generate or repair `flake.nix`.

## Documentation tools

- [`kiki-docs-catchup`](.agents/skills/kiki-docs-catchup/SKILL.md): classify a coherent candidate, establish evidence and lineage, select canonical paths, and prepare bounded semantic or mechanical work.
- [`translate-docs`](.agents/skills/translate-docs/SKILL.md): synchronize an already-decided bilingual page pair.
- [`gen-docs`](.agents/skills/gen-docs/SKILL.md): update selected mirrored user guides, configuration, and reference pages within the catch-up boundary; it does not own changelog pages.
- [`kiki-docs`](.agents/skills/kiki-docs/SKILL.md): answer read-only Kiki documentation questions; it does not maintain docs.
- [`sync-changelog`](.agents/skills/sync-changelog/SKILL.md): exclusively curate and synchronize the two changelog pages after release.

Run `node scripts/check-docs-governance.mjs` for structural mirror, heading, navigation, link, and skill-resource checks. A passing result does not prove that prose is accurate, complete, or correctly classified; semantic acceptance comes from the candidate's source and test evidence plus review of the affected reader decisions.
