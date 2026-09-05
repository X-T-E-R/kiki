# apps/kimi-code Development Guide

This file only contains rules local to `apps/kimi-code`. For cross-repo rules, see the root `AGENTS.md`.

> **Writing or modifying the TUI?** Use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`). It covers the architecture orientation, where new features go, test placement, theme mechanics, and the dialog interaction/visual spec (`DESIGN.md`). This file keeps only the map, boundaries, and hard constraints.

## TUI File Layout

`apps/kimi-code` is the terminal UI / CLI app. The interactive entry chain is:

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> daemon attach-or-spawn -> `src/tui/daemon/daemon-tui.ts`

Main directories:

- `src/constant/`: non-copy constants shared by CLI/TUI — product, protocol, paths, terminal control, updates, and so on.
- `src/cli/`: command-line arguments, subcommands, and CLI startup.
- `src/tui/`: the interactive terminal UI.
- `src/tui/daemon/`: daemon discovery, transport adapters, command registry, transcript rendering, and the `DaemonTUI` coordinator.
- `src/tui/tui-state.ts`: `TUIState` and `createTUIState` — the shared UI-state shape.
- `src/tui/commands/`: parsers shared with non-interactive CLI paths; interactive slash commands live in the daemon registry.
- `src/tui/components/`: pi-tui components, organized by UI type.
- `src/tui/constant/`: non-copy constants reused across TUI modules — symbols, terminal sequences, render sizing, streaming-arg match rules, and so on.
- `src/tui/components/chrome/`: persistent UI chrome — footer, todo panel, welcome, loader, device code.
- `src/tui/components/dialogs/`: selectors, approval panels, question popups, and settings popups that temporarily replace the editor.
- `src/tui/components/editor/`: the custom input box and the file mention provider.
- `src/tui/components/media/`: image, diff, code highlight, and other media displays.
- `src/tui/components/messages/`: message blocks in the transcript — assistant, user, tool call, thinking, usage, subagent, and so on.
- `src/tui/components/panes/`: right-side / activity-area panes such as the activity pane and queue pane.
- `src/tui/interactions/`: neutral approval/question panel types and adapters.
- `src/tui/theme/`: themes, color tokens, style helpers, terminal-background detection, and the pi-tui markdown theme.
- `src/tui/utils/`: TUI-only utility functions.
- `src/utils/`: app-wide utilities — clipboard, git, history, image, process, usage, and so on.

## Daemon TUI

- Interactive `kimi`/`kiki` shells always attach to or spawn the shared daemon and run `DaemonTUI`; there is no runtime legacy-TUI fallback.
- The daemon TUI command registry must identify supported and disabled commands in both autocomplete and `/help`; unknown slash input must not become a prompt unless it matches a discovered Skill or agent profile.
- Commands without a daemon contract stay explicitly disabled in the registry rather than simulating support client-side.

## Module Responsibilities

- `cli` only interprets command-line input, assembles startup arguments, and invokes the TUI. Do not put TUI interaction logic into the CLI.
- `DaemonTUI` coordinates state, layout, editor input, session-core state, dialogs, and slash-command dispatch.
- `daemon/commands.ts` owns interactive slash-command declaration, parsing, support status, and argument validation.
- `components` only handle presentation and local interaction; they must not call the SDK or daemon client directly, and must not read or write session state directly.
- `interactions` converts approval/question requests into the data shape a UI panel/dialog needs and converts user choices back into daemon responses.
- `theme` is the single source of truth for colors and styles. Components must not bypass the theme system and use chalk named colors directly.
- `utils` holds utility functions with no UI-state dependency. Logic that needs `TUIState` or a component instance must not live under app-level `src/utils`.
- The daemon TUI may consume `@kiki/session-core` and `@moonshot-ai/klient`; other app paths continue to use `@moonshot-ai/kimi-code-sdk`. Never import `@moonshot-ai/agent-core-v2` directly in app code.

## TUI Coding Conventions

- Do not over-encapsulate, especially for one- or two-line functions — do not introduce a two-layer wrapper, just inline.
- Functions with no state / UI side effects do not belong as private methods on `DaemonTUI`; put them in external utils.
- Constants must live in the corresponding `constant` directory; they must not be scattered through component or logic code.
- Inside `handleInput(data)`, when comparing a printable character (letter, digit, space, punctuation), it is **forbidden** to write literal comparisons such as `data === 'q'`. With the Kitty keyboard protocol enabled in terminals like VSCode, these keys are sent as CSI-u sequences (e.g. `\x1b[113u`), and a bare comparison will never match. Decode with `printableChar(data)` from `src/tui/utils/printable-key.ts` first, then compare; function keys continue to use `matchesKey(data, Key.*)`; control characters (codepoint < 32) may still be compared against the raw `data`. `test/tui/printable-key-guard.test.ts` enforces this in CI.

## Color Rules (normative)

The theme apply/switch mechanics live in the `write-tui` skill. The following rules are hard and guard-enforced:

- Do not use chalk named colors such as `chalk.red`, `chalk.cyan`, `chalk.white`, `chalk.gray`, `chalk.dim`, or `chalk.yellow` directly.
- If a component already has `colors`, use `chalk.hex(colors.<token>)(text)`.
- If a component already has `state.theme.styles` or styles passed in, prefer helpers such as `styles.error(text)`, `styles.dim(text)`.
- When new visual semantics have no token, first add a semantic field to `ColorPalette`, and fill in both `darkColors` and `lightColors`.
- In light themes, text tokens against a white background must be at least 4.5:1; borders and large chrome must be at least 3:1.
- Do not cache styled chalk functions at module top level. Theme switching must take effect within a single render, so styles must be generated on the render path from the current palette.
- Non-comment code must not contain chalk named colors such as `chalk.white`, `chalk.cyan`, `chalk.red`, `chalk.green`, `chalk.gray`, `chalk.yellow`, `chalk.blue`, `chalk.magenta`, `chalk.whiteBright`, or `chalk.blackBright`. `test/tui/chalk-named-color-guard.test.ts` enforces this in CI.

## General Coding Requirements

- `runShell()` must complete `runWorkspaceTrustGate()` before daemon discovery/spawn, explicit skill or agent source registration, TUI startup, or any workspace-derived child process. Pre-trust external commands must be resolved with `resolveCommandPath` from `src/utils/process/resolve-command.ts`, which returns an absolute PATH hit and refuses matches inside the cwd.
- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
