# Contributing to Kiki

This guide covers what Kiki expects from a pull request, how to set up the
repo, and which checks run before merge.

## Before You Start

Kiki already has opinions on CLI/TUI behavior, agent workflows, and public APIs. If your change shifts that direction, open an issue first so we can align before you invest time in a PR.

**You should understand what you submit** — what changed, how it behaves at the edges, and why it fits this codebase. This applies to AI-assisted contributions too; if you cannot explain the change, the PR is not ready for review.

We only merge PRs aligned with the roadmap. Drive-by refactors without context are unlikely to land.

**Discuss first** — open an issue before coding. PRs without prior discussion may be closed without review:

- New features or user-visible behavior changes (regardless of size)
- Refactors or other changes larger than ~100 lines
- Public API or compatibility changes
- Bug fixes where the cause or fix approach is still unclear

**Can open a PR directly** — link an existing issue when there is one:

- Clear, reproducible bug fixes with a focused diff
- Typos, documentation-only changes, and small CI/build fixes
- Small changes that clearly match an existing issue or maintainer request

## Project Layout

This is a pnpm monorepo. The most relevant entry points are:

- `apps/kimi-code` — CLI / TUI, published to npm as `kiki-agent` / `kiki-agent-lite`
- `apps/vscode` — VS Code extension
- `apps/kiki-gui` — the GUI that `apps/kimi-code` serves from `kiki web`
- `packages/agent-core-v2` — the agent engine
- `packages/klient` — client SDK used by the server and GUI
- `packages/kap-server` — the Kiki server
- `docs/` — VitePress documentation site

Most `packages/*` are workspace packages marked `private: true`, so they are not
published to npm as their own releases. That flag describes distribution, not
API design: these packages still have real, used contracts, and their READMEs
document them. Check a package's `package.json` `private` and `publishConfig`
fields for its current distribution state. For the full map, see
[AGENTS.md](AGENTS.md).

## Development Setup

Prerequisites: Node.js >= 24.15.0, pnpm 10.33.0, Git.

```sh
git clone https://github.com/X-T-E-R/kiki.git
cd kiki
pnpm install
```

Useful scripts:

- `pnpm dev:cli` — run the CLI in dev mode
- `pnpm test` — run tests (vitest; L0 + L1; L2 files self-skip unless env-gated)
- `pnpm test:fast` — L0 only (`*.test.ts`, skips `*.integration.ts` / `*.e2e.ts`)
- `pnpm test:integration` — L1 files (`*.integration.ts`)
- `pnpm test:promote` — the local promote gate: engine/CLI/GUI L0+L1, the kap-server L0/fast subset, plus `packages/pi-tui` (`node --test`). Run `pnpm test:kap-server:integration` for kap-server's full `*.integration.ts` set
- `pnpm typecheck` — TypeScript check (note: builds packages first)
- `pnpm lint` — oxlint
- `pnpm lint:fix` — oxlint with auto-fix
- `pnpm build` — build all packages

## Commit Convention

All commits and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/).

| Type     | Use for                                     | Example                                   |
|----------|---------------------------------------------|-------------------------------------------|
| feat     | A new feature                               | feat(agent-core-v2): add tool dedup          |
| fix      | A bug fix                                   | fix(tui): correct status bar alignment    |
| docs     | Documentation only                          | docs: clarify install instructions        |
| chore    | Tooling / housekeeping                      | chore: bump dependencies                  |
| refactor | Internal refactor without behavior change   | refactor(core): extract retry helper      |
| test     | Adding or improving tests                   | test(agent-core-v2): cover skill resolver    |
| ci       | CI / build pipeline changes                 | ci: cache pnpm store                      |
| build    | Build system / artifact changes             | build(native): add win32-arm64 target     |
| perf     | Performance improvement                     | perf(session): batch event flushes        |
| style    | Formatting only (no logic)                  | style: apply oxlint --fix                 |

PR titles are enforced by the `pr-title-checker` workflow — a non-conforming title will block merge.

## Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage versioning and releases.

- Every PR that affects release artifacts (code, behavior, public API) **must** include a changeset.
- Docs-only, test-only, or CI-only PRs may skip changesets.
- Generate one with `pnpm changeset` and follow the prompts (which packages are touched, which bump level).
- For repo-specific conventions on package selection and bump levels, see `.changeset/README.md`. When working in this repo with coding agents, use the `gen-changesets` skill.

## Pull Requests

Use the [PR template](.github/pull_request_template.md) when opening a feature pull request.

PR titles must follow [Conventional Commits](#commit-convention); CI runs `pnpm lint`, `pnpm typecheck`, and `pnpm test` on every PR.

If your change alters behavior a reader can observe — a command, a setting, a
protocol, a default — say so in the PR's documentation impact checklist so the
matching doc lands in the same change. The PR template explains the
categories; [the documentation lifecycle](docs/AGENTS.md#documentation-lifecycle)
has the full rule.

## Code Style

- TypeScript across the codebase.
- Linting via `oxlint` (config in `.oxlintrc.json`).
- Auto-formatting via `pnpm lint:fix`.
- Follow existing local patterns when the lint rules do not cover a style choice.

## Reporting Security Issues

Found a security issue? Please see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE).
