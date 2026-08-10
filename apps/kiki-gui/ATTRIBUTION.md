# Attribution and provenance

The `@kiki/gui` package declares an MIT license. This document records the
known sources of adapted upstream material and the licenses of its direct
application dependencies. It is a provenance summary, not a complete set of
notices for distribution.

## Adapted upstream material

The license in this table applies to material from the named upstream project
at the pinned revision. It does not, by itself, assign that license to an
entire kiki-gui target file.

| Donor | Pinned upstream revision | Upstream license | Recorded use in kiki-gui |
| --- | --- | --- | --- |
| [codeg](https://github.com/xintaofei/codeg) | [`fa230248d285c3f4fa541a737fc93f209820512e`](https://github.com/xintaofei/codeg/commit/fa230248d285c3f4fa541a737fc93f209820512e) | Apache-2.0 | Lazy Streamdown engine loading; stick-to-bottom and jump-to-latest thread behavior; target-aware Tauri externalBin staging |
| [AionUi](https://github.com/iOfficeAI/AionUi) | [`28a2a9f57f1bf4f9111b9c33e0cfc1eb918effc8`](https://github.com/iOfficeAI/AionUi/commit/28a2a9f57f1bf4f9111b9c33e0cfc1eb918effc8) | Apache-2.0 | Code-block controls; approval intent and submit guards; capability degradation in the model and effort selector |
| [grok-build](https://github.com/xai-org/grok-build) | [`a5589e958437d79e13db026eedcb1720bffd4063`](https://github.com/xai-org/grok-build/commit/a5589e958437d79e13db026eedcb1720bffd4063) | Apache-2.0 | Unified-diff hunk generation, context trimming, unchanged-line separators, and diffstat presentation |
| [LiveAgent](https://github.com/Stack-Cairn/LiveAgent) | [`00a2c6fc43754f40022b0703459824559bee73ea`](https://github.com/Stack-Cairn/LiveAgent/commit/00a2c6fc43754f40022b0703459824559bee73ea) | MIT | Wake-nudge reconnect policy and wake-signal wiring; bounded managed-child shutdown and process-tree fallback |

## Direct application dependencies

Versions below are the current resolutions for the `apps/kiki-gui` importer in
`pnpm-lock.yaml`. The workspace dependency has no standalone lockfile version.

| License | Package and current lockfile resolution |
| --- | --- |
| Apache-2.0 | `streamdown` 2.5.0; `@streamdown/code` 1.1.1 |
| Apache-2.0 OR MIT | `@tauri-apps/api` 2.11.1 |
| BSD-3-Clause | `diff` 8.0.4 |
| MIT | `@moonshot-ai/protocol` (workspace link); `@tanstack/react-query` 5.99.2; `react` 19.2.5; `react-dom` 19.2.5; `use-stick-to-bottom` 1.1.6 |
| OFL-1.1 | `@fontsource-variable/fraunces` 5.3.0; `@fontsource/jetbrains-mono` 5.3.0; `@fontsource/space-grotesk` 5.3.0 |

Shiki 3.23.0 is an MIT-licensed transitive dependency of
`@streamdown/code`; kiki-gui does not declare Shiki as a direct dependency.

Packages under `devDependencies` in `apps/kiki-gui/package.json` are build,
type-checking, test, and visual-proof tooling rather than direct application
dependencies. They are not covered by the runtime table above.

## Distribution notices

Before a release is distributed, generate the third-party notice set from the
final resolved dependency graph and the assets that actually ship. That notice
set must include the license texts, copyright notices, and other attribution
materials required by the applicable upstream licenses. This file does not
claim that the distribution notice set is complete or that release compliance
has been established.
