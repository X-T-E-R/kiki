# Acknowledgements

Kiki stands on other people's work. This page names the open-source projects it reuses code from, and the projects whose ideas shaped it without any of their code. Each entry says what Kiki took and under which license.

For the pinned upstream revisions behind the desktop app's adapted code, see [apps/kiki-gui/ATTRIBUTION.md](apps/kiki-gui/ATTRIBUTION.md) and [apps/kiki-gui/THIRD_PARTY_NOTICES.md](apps/kiki-gui/THIRD_PARTY_NOTICES.md).

## Code reuse

These projects are forked, vendored, ported, adapted, or depended on directly.

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** (MIT). Kiki started as a whole-tree fork of Kimi Code: the CLI, the agent engine, the protocol packages, the plugins, and the docs all grew from it. The original copyright notice is kept in [LICENSE](LICENSE).
- **[pi-mono / pi-tui](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)** (MIT). The terminal UI runs on a vendored copy of pi-tui in `packages/pi-tui`, with its differential renderer, editor, and Markdown component. Its license is kept in `packages/pi-tui/LICENSE`.
- **[OpenTUI](https://github.com/anomalyco/opentui)** (MIT). pi-tui's stdin buffer, which splits raw terminal input into complete escape sequences, is based on OpenTUI's code.
- **[codeg](https://github.com/xintaofei/codeg)** (Apache-2.0). The desktop app adapts codeg's lazy loading of Streamdown's code, math, and Mermaid engines, its stick-to-bottom thread scrolling, its collapsible-overflow hook, and the script that stages the Kiki server as a Tauri sidecar. The folded turn history follows codeg's settled-turn fold.
- **[AionUi](https://github.com/iOfficeAI/AionUi)** (Apache-2.0). Code-block controls (language label, copy, collapse for long blocks), the approval strip's submit guards, and the model and effort selector's handling of missing capabilities are adapted from AionUi. The selection quote button follows its reply-to-selection behavior.
- **[grok-build](https://github.com/xai-org/grok-build)** (Apache-2.0). Edit diffs use grok-build's recipe: three lines of context, merged nearby hunks, "N unchanged lines" separators, and a `+N/-M` diffstat.
- **[LiveAgent](https://github.com/Stack-Cairn/LiveAgent)** (MIT). The desktop app's reconnect-on-wake policy and its bounded shutdown of the managed server process are adapted from LiveAgent. The composer's context menu and the per-message tick rail at the edge of the timeline are modeled on LiveAgent's.
- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT). Much of the conversation shell comes from here: the hero and docked composer phases, the shared content width, the reasoning row's summary rule and scan animation, failure-first tool summaries, the turn's running clock and end-of-turn readout, and `@agent` chips in user messages. The SQLite search index's schema guard is adapted from its session-query package.
- **[LiteLLM](https://github.com/BerriAI/litellm)** (MIT). Kiki ships a snapshot of LiteLLM's model price and context-window table in `packages/kap-server/vendor/litellm`, with a NOTICE that records the upstream revision.
- **[nb-search](https://github.com/NB-Corp/nb-search)** (MIT). Web search and page fetching run on nb-search, vendored as a patched release under `vendor/` with its license and patch provenance.
- **[tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)** (MIT). Kiki's pure-TypeScript bash parser, used to judge whether a shell command is safe to run, reproduces tree-sitter-bash's grammar rules and node types, and is tested against the real grammar.
- **[Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)** (Apache-2.0). `kiki acp` and Kiki's support for external ACP engines are built on the official SDK.
- **[Streamdown](https://github.com/vercel/streamdown)** (Apache-2.0). Streaming Markdown, syntax-highlighted code, CJK text, math, and diagrams in the desktop app and file previews render through Streamdown and its plugins.
- **[Tauri](https://github.com/tauri-apps/tauri)** (Apache-2.0 OR MIT). The desktop shell, installers, native dialogs, notifications, and the signed Windows updater are built with Tauri and its plugins.
- **[xterm.js](https://github.com/xtermjs/xterm.js)** (MIT). The desktop app's terminal panel.
- **[CodeMirror](https://github.com/codemirror)** (MIT). Text and code editing in the desktop app.
- **[use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom)** (MIT). Keeps the conversation pinned to the latest message while it streams.

## Design reference only

Kiki borrows ideas or behavior from these projects but contains none of their code.

- **[Claude Code](https://github.com/anthropics/claude-code)** (proprietary). Kiki's four memory types (user, feedback, project, reference) follow Claude Code's. Kiki can also install Claude Code plugins through their `.claude-plugin/plugin.json` manifest, which it reads with its own importer.
- **[OpenAI Codex](https://github.com/openai/codex)** (Apache-2.0). The split between searching, reading, and listing session history follows Codex's tools. Kiki's managed worktrees clear inherited git environment variables the way Codex does, and the Codex-compatible request identity matches its User-Agent shape.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (MIT). The history tools' discovery, anchors, and honest failure reporting were modeled on Hermes's session search.
- **[magic-context](https://github.com/cortexkit/magic-context)** (MIT). History search filters candidates before applying result caps, as magic-context does.
- **[Letta Code](https://github.com/letta-ai/letta-code)** (Apache-2.0). Every memory write carries a required reason, as in Letta Code, so each change can be explained and undone.
- **[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)** (MIT). Editing a sent message in place follows AnythingLLM's edit form, and the composer's undo stack uses the same 100-entry cap.
- **[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)** (Apache-2.0). The Capabilities page's grouped, collapsible cards follow the structure of dsh-web-ui's plugin groups.

Thank you to everyone who builds these projects in the open.
