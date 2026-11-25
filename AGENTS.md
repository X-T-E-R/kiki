# Repository-level Agent Guide

Reply in the same language as the user.

> **Source of truth:** Code and passing tests override prose. When any `AGENTS.md`, `MAINTAINERS.md`, or doc disagrees with existing code, follow the existing code (unless your task explicitly changes that contract) and report every doc-vs-code inconsistency in your final reply.
>
> **Reuse before creating:** Before creating any app, module, UI view, or helper, inspect `apps/*`, `packages/*`, and `## Workspace Map` below to reuse an existing surface or single-source package rather than duplicating logic.

Keep this root guide limited to hot-path rules. Follow the nearest subtree `AGENTS.md`, keep changes focused, and never add co-author lines or agent identity to commits, PRs, or public prose.

## Workspace Map

Kiki maintains **two UI codebases** across all client surfaces:
- **GUI base (`apps/kiki-gui`)**: shared React 19 UI serving Web (`kiki web`), Tauri Desktop (`apps/kiki-gui/src-tauri`), VS Code thin Webview bridge (`apps/vscode`), Capacitor Mobile remote shells (`apps/kiki-gui/mobile`), and the Android local host (`apps/kiki-android` via `KikiWebActivity`). Do not create parallel graphical frontends.
- **CLI/TUI base (`apps/kimi-code`)**: CLI, `DaemonTUI` (`@kiki/pi-tui`), and SEA binary consuming `@kiki/session-core` and `@kiki/klient`.

### Apps, Surfaces & Docs

| Path | Role & Key Entrypoints |
| --- | --- |
| `apps/kimi-code` | CLI, `DaemonTUI`, and SEA entrypoint (`@kiki/cli`); uses `@kiki/klient`, `@kiki/session-core`, `@kiki/node-sdk`; TUI work uses `.agents/skills/write-tui/SKILL.md` and `apps/kimi-code/AGENTS.md`. |
| `apps/kiki-gui` | Shared browser, desktop, and responsive mobile React UI (`@kiki/gui`); visual acceptance uses `apps/kiki-gui/scripts/visual-proof.mjs`; see `apps/kiki-gui/AGENTS.md`. |
| `apps/kiki-gui/src-tauri` | Tauri v2 desktop shell wrapping `apps/kiki-gui` and the local SEA sidecar. |
| `apps/kiki-gui/mobile` | Unified Capacitor (`@capacitor/{ios,android}`) remote pairing shell (`launcher/`, iOS `SceneDelegate.swift`, Android `KikiShellPlugin.java`). |
| `apps/kiki-android` | Independent 4-module Gradle Android local host embedding Bionic Node and rendering `apps/kiki-gui` in `KikiWebActivity` (`./gradlew testDebugUnitTest`). |
| `apps/vscode` | Thin VS Code Webview bridge (`kiki`) hosting packaged `apps/kiki-gui` assets; see `apps/vscode/README.md`. |
| `docs` | Bilingual VitePress documentation site (`@kiki/docs`, `docs/en/` & `docs/zh/`); see `docs/AGENTS.md`. |

### Packages

| Path | Package | Role |
| --- | --- | --- |
| `packages/acp-client` | `@kiki/acp-client` | Outbound Agent Client Protocol process and session engine; see `packages/acp-client/README.md`. |
| `packages/acp-server` | `@kiki/acp-server` | Inbound ACP host backed by `@kiki/agent-core-v2` and `@kiki/klient`. |
| `packages/agent-core-v2` | `@kiki/agent-core-v2` | Sole agent engine (DI × Scope: `App`/`Session`/`Agent` in `packages/agent-core-v2/src/app/scopes.ts`, leased `WorkspaceInstance`/`Program`, L3 units/Features); see `packages/agent-core-v2/AGENTS.md` and `.agents/skills/agent-core-dev/SKILL.md`. |
| `packages/agent-profiles` | `@kiki/agent-profiles` | Agent profile parsing, discovery, and catalog projection; see `packages/agent-profiles/README.md`. |
| `packages/auth-native` | `@kiki/auth-native` | Native age passphrase encryption and advisory auth locks (Rust N-API). |
| `packages/codex-client` | `@kiki/codex-client` | Outbound Codex app-server process and turn client. |
| `packages/cordis-runtime` | `@kiki/cordis-runtime` | Hardened Cordis plugin runtime plane and singleton scope routing. |
| `packages/kaos` | `@kiki/kaos` | Execution environment, shell, and filesystem/process abstractions; see `packages/kaos/README.md`. |
| `packages/kap-server` | `@kiki/kap-server` | Kiki REST + WebSocket server (`/api`, `/api/ws`, `--debug-endpoints`); see `packages/kap-server/AGENTS.md`. |
| `packages/klient` | `@kiki/klient` | Contract-driven client SDK facade (`@kiki/klient/http\|ipc\|memory`) and e2e suites; see `packages/klient/AGENTS.md`. |
| `packages/lexical` | `@kiki/lexical` | Dependency-free ASCII/CJK tokenization and Unicode normalization for Memory, history, and SQLite FTS5. |
| `packages/node-sdk` | `@kiki/node-sdk` | Public TypeScript SDK, CLI print harness, and worker-heap policy; see `packages/node-sdk/README.md`. |
| `packages/oauth` | `@kiki/oauth` | OAuth toolkit for managed Kimi Code authentication; see `packages/oauth/README.md`. |
| `packages/pi-tui` | `@kiki/pi-tui` | Vendored differential-rendering terminal UI library (runs on `node --test`); see `packages/pi-tui/AGENTS.md`. |
| `packages/plugin-sdk` | `@kiki/plugin-sdk` | Public authoring contracts and media/panel schemas for Kiki plugins. |
| `packages/protocol` | `@kiki/protocol` | Shared browser-safe Zod wire schemas, REST/WS contracts, pairing helpers, and error envelopes. |
| `packages/session-core` | `@kiki/session-core` | Framework-free client session controller, settings models (`packages/session-core/src/settings/settings.test.ts`), composer helpers, and i18n; see `packages/session-core/AGENTS.md`. |
| `packages/shell-quoting` | `@kiki/shell-quoting` | Dependency-free POSIX `shlex.quote` and Windows `cmd` shell argument quoting utilities. |
| `packages/transcript` | `@kiki/transcript` | Pure-TS isomorphic transcript data layer (L1–L4) and op-batch sequencing contract; see `packages/transcript/AGENTS.md`. |
| `packages/transcript-live` | `@kiki/transcript-live` | Engine-event bindings producing canonical transcript operations; see `packages/transcript-live/AGENTS.md`. |
| `packages/tree-sitter-bash` | `@kiki/tree-sitter-bash` | Pure-TS budgeted bash parser (parser only, no safety judgments); see `packages/tree-sitter-bash/README.md`. |

## Environment & Workspace Sync

- **Toolchain**: Node `>=24.22.1 <25 || >=26.12.1` (`.nvmrc` = `24.22.1`), `pnpm@10.33.0` (`engine-strict=true` in `.npmrc`).
- **Workspace parity**: Whenever adding or removing a workspace package, update `pnpm-workspace.yaml`, `flake.nix` (`workspacePaths` and `workspaceNames`), and `## Workspace Map` above in the same change, then run `pnpm run check:meta` (`scripts/check-repo-meta.mjs` enforces workspace parity, `scripts/check-nix-workspace.mjs`, dependency boundaries, and links).

## Coding, Testing & Flags

- **Comment-free zones**: `packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` forbid comments except exported-symbol JSDoc and `oxlint-disable`/`eslint-disable` (`scripts/check-no-comments.mjs` in `pnpm lint`).
- **TypeScript conventions**: pass `{ user }` instead of conditional spread for optional properties; omit redundant `| undefined` on optional property types; do not wrap single-parameter internal methods in options objects; prefer `import ... from '#/...'`; non-package-root `index.ts` files prefer `export * from './module';`.
- **Anti-test-bloat**: Add permanent tests only for durable contracts, wire/protocol boundaries, security invariants, and real regressions—never for trivial copy, type-guaranteed invariants, or mock-call mirrors. Prefer extending existing test files. Put throwaway repro scripts in `.tmp/` and delete them before committing. When user changes invalidate a test, fix the test unless the implementation has a bug.
- **Experimental flags**: Ship product features enabled by default; gate only real rollout/rollback boundaries using distributed `registerFlagDefinition` + `IFlagService.enabled(id)` (see `packages/agent-core-v2/docs/flag.md`) and keep `packages/session-core/src/settings/settings.test.ts` green.

## Workflow & Pointers

- **Discovery & hygiene**: Prefer `rg` / `rg --files`. Replace real internal identifiers in public text and fixtures with neutral placeholders (`example.com`, `example.test`, `YOUR_API_KEY`). Never commit scratch handoffs (`HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`) or throwaway mockups (`*-mockup.html`, `*-demo.html`, `*-designs.html`); keep scratch files under `.tmp/`.
- **PRs & changesets**: Use Conventional Commit PR titles, fill `.github/pull_request_template.md`, and evaluate user-perceivable changesets per `.agents/skills/gen-changesets/SKILL.md` (never choose a `major` bump without explicit user approval).
- **References**: Maintainer router [`MAINTAINERS.md`](MAINTAINERS.md) · Docs lifecycle [`docs/AGENTS.md`](docs/AGENTS.md#documentation-lifecycle) · Upstream sync [`docs/maintainer/upstream-sync.md`](docs/maintainer/upstream-sync.md).
