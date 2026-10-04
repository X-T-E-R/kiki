# Kiki desktop third-party notices

Kiki desktop is built from open-source components. The exact JavaScript and Rust dependency versions shipped by a release are recorded in the repository's `pnpm-lock.yaml` and `apps/kiki-gui/src-tauri/Cargo.lock` at the matching `kiki-v<version>` tag. License identifiers below link to the applicable project license or standard license text.

This static notice covers the bundled sidecar, major direct desktop runtime dependencies, and source adapted from recorded donors. Release owners must review it when either lockfile, the desktop sidecar, or adapted source changes.

## Bundled runtime and major direct dependencies

| Component | Use in Kiki desktop | License |
| --- | --- | --- |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | Bundled `kiki-server.exe` sidecar | MIT |
| [agent-browser 0.38.2](https://github.com/vercel-labs/agent-browser/tree/39a74c70d7759d5a6de7a22c04570bb626bbd081), Kiki `kiki-no-replay-r1` / `kiki-stdio-r1` derivative | Managed browser MCP execution resource embedded in the Windows sidecar; modified transport does not replay indeterminate operations, and Windows MCP output capture follows the CLI's exit rather than inherited background writers. LICENSE, NOTICE, build metadata and patch accompany the extracted resource. | Apache-2.0 |
| [Tauri](https://github.com/tauri-apps/tauri), updater, dialog, filesystem, notification, and window-state plugins | Windows desktop runtime, NSIS packaging, native integration, and signed updates | Apache-2.0 OR MIT |
| [React](https://github.com/facebook/react) and React DOM | Desktop user interface runtime | MIT |
| [React Router](https://github.com/remix-run/react-router) | Desktop client routing | MIT |
| [CodeMirror](https://github.com/codemirror) packages | Text and code editing | MIT |
| [`@moonshot-ai/protocol`](https://github.com/MoonshotAI/kimi-code) | Workspace protocol library used by the desktop client | MIT |
| [TanStack Query](https://github.com/TanStack/query) | Client-side server-state management | MIT |
| [Streamdown](https://github.com/vercel/streamdown) and `@streamdown/code`, `@streamdown/cjk`, `@streamdown/math`, `@streamdown/mermaid` | Streaming Markdown, code, CJK text, math, and diagram rendering | Apache-2.0 |
| [KaTeX](https://github.com/KaTeX/KaTeX) and [Mermaid](https://github.com/mermaid-js/mermaid) | Math typesetting and diagram rendering | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js), addon-fit, and addon-web-links | Terminal rendering and integration | MIT |
| [diff](https://github.com/kpdecker/jsdiff) | Unified diff processing | BSD-3-Clause |
| [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) | Conversation scroll behavior | MIT |
| Fraunces, JetBrains Mono, and Space Grotesk Fontsource packages | Fonts bundled with the desktop UI | OFL-1.1 |

## Adapted source and interaction donors

| Donor and pinned revision | Recorded use in Kiki desktop | License |
| --- | --- | --- |
| [codeg `fa230248`](https://github.com/xintaofei/codeg/commit/fa230248d285c3f4fa541a737fc93f209820512e) | Streamdown loading, thread scrolling, and Tauri sidecar staging | Apache-2.0 |
| [AionUi `28a2a9f`](https://github.com/iOfficeAI/AionUi/commit/28a2a9f57f1bf4f9111b9c33e0cfc1eb918effc8) | Code-block controls, approval guards, and capability degradation | Apache-2.0 |
| [grok-build `a5589e9`](https://github.com/xai-org/grok-build/commit/a5589e958437d79e13db026eedcb1720bffd4063) | Unified-diff presentation | Apache-2.0 |
| [LiveAgent `00a2c6f`](https://github.com/Stack-Cairn/LiveAgent/commit/00a2c6fc43754f40022b0703459824559bee73ea) | Reconnect policy and managed-child shutdown behavior | MIT |
| [deepseek-harness `47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a) | Conversation-shell, composer, status, tool, queue, and reference-chip interaction patterns | MIT |
| [dsh-web-ui `6265187`](https://github.com/zhu1090093659/dsh-web-ui/commit/62651870dd18ad3d9bf54a9cb934b75d0fbaf639) | Grouped collapsible capability cards | Apache-2.0 |
| [Letta Code `c0956ed`](https://github.com/letta-ai/letta-code/commit/c0956ed3263da7f781a958ce35ff3042ef97adfa) | Partial JSON string-field scanner for streaming SendMessage drafts (`src/lib/partialJson.ts`) | Apache-2.0 |
| [OpenCode `e00890c`](https://github.com/anomalyco/opencode/commit/e00890c67261a435cee6409366a68999a93393fd) | Account sign-in behaviour behind the device-code flows the Connections page runs: the xAI/Grok device-grant adapter attributed in full at `packages/oauth/THIRD_PARTY_NOTICES.md`, which ships with the desktop build | MIT |

The Kiki repository itself is distributed under the MIT License in the repository root. Copyright and license notices supplied by third-party projects remain the property of their respective authors.
