---
name: write-tui
description: Use when writing or modifying the daemon-backed kimi-code terminal UI in apps/kimi-code/src/tui.
---

# Write TUI (apps/kimi-code)

The interactive terminal UI is daemon-backed. Before changing it, read `apps/kimi-code/AGENTS.md`. For list dialogs, selectors, input boxes, and toggle/status lists, also read [DESIGN.md](./DESIGN.md); its keyboard, width, color, and layout rules are normative.

## Interactive architecture

The startup chain is:

`src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → workspace trust → daemon attach-or-spawn → `src/tui/daemon/daemon-tui.ts`

There is no legacy `KimiTUI` runtime path or experimental selector.

- `src/cli/run-shell.ts` owns trust ordering, daemon connection setup, process/signal cleanup, and terminal restoration. It must not contain session interaction logic.
- `src/tui/daemon/daemon-tui.ts` is the coordinator. It wires `TUIState`, editor callbacks, `SessionController`, daemon commands, dialogs, session navigation, and lifecycle cleanup.
- `src/tui/daemon/client.ts` delegates session actions to the shared session-core Klient adapter and keeps small REST adapters not already represented by the public Klient facade.
- `session(id).view` supplies ordered snapshots, transcript pages, and live recovery on the Klient event socket; there is no separate daemon session socket.
- `src/tui/daemon/transcript-renderer.ts` projects session-core transcript blocks onto shared TUI message/media components.
- `src/tui/daemon/commands.ts` is the interactive slash-command source of truth. Every catalog command is explicitly `supported` or `disabled`; `/help` and autocomplete are generated from the same table.
- `src/tui/interactions/` owns neutral approval/question dialog types and request/response adapters.
- `src/tui/tui-state.ts` constructs shared terminal, layout, editor, footer, todo, and container state.
- `src/tui/components/`, `theme/`, `constant/`, and `utils/` remain reusable presentation and rendering layers.

## Core boundaries

- Session snapshots, transcript ordering, reconnect/resync, prompt submission, abort, history rewrites, agent forest state, todos, tasks, usage, and retry state come from `@kiki/session-core`.
- Prefer `@kiki/klient` facades for daemon capabilities: `global.*`, `session(id).*`, and `session(id).agent(id).*`.
- Add a REST adapter to `daemon/client.ts` only when an existing public REST contract has no Klient facade. Do not add raw service/procedure escape hatches.
- Components do not call Klient, REST, the SDK, or session-core controllers. They receive view data and callbacks.
- Commands without a real daemon contract stay disabled. Unknown slash input must never fall through as a prompt; discovered Skill and profile commands are the only dynamic exceptions.

## Feature routing

- CLI startup flags and trust/lifecycle behavior → `src/cli/run-shell.ts`, then pass data into `DaemonTUI`.
- Interactive slash declarations, aliases, help status, and argument validation → `src/tui/daemon/commands.ts`.
- Command execution and session coordination → `DaemonTUI`; move pure parsing/projection helpers into `daemon/` or `utils/`.
- Session/transcript behavior → use or extend session-core contracts first.
- Approval/question adaptation → `src/tui/interactions/`; presentation remains under `components/dialogs/`.
- Transcript block rendering → `src/tui/daemon/transcript-renderer.ts`, reusing `components/messages/` and `components/media/`.
- Session list pagination/search/scope → `SessionPickerComponent` plus daemon keyset pages; do not truncate backend pagination at the first page.
- Skill commands → session skill catalog and real `activateSkill` / `promptWithSkills` contracts. Inline skill tokens must not be sent as plain prompts.
- Attachments → daemon file uploads and real prompt content parts. Keep placeholder expansion deterministic and render structured media from session-core blocks.
- Footer/todo/activity/task state → project session-core `SessionViewState`; do not reconstruct parallel state from ad hoc events.
- Agent navigation → session-core forest/roster plus focused-agent transcript subscriptions.
- New selector/dialog → `components/dialogs/`, mounted with the coordinator’s editor-replacement helpers, following `DESIGN.md`.

## Keyboard rules

- Printable characters must be decoded with `printableChar()` before comparison; function/control keys use `matchesKey()` and `Key.*`.
- Preserve editor-native history, empty Up/Down, paste buffering, and text paste behavior unless a real coordinator action consumes the callback.
- Ctrl-C interrupts active work before exit confirmation; Ctrl-D exits only through the confirmed shutdown path.
- Ctrl-O toggles tool output, Ctrl-T toggles overflowing todos, Ctrl+- invokes the real undo contract, and Shift-Tab toggles plan mode.
- A bound callback must either perform its advertised operation or display an explicit disabled result.

## Theme and dialog mechanics

Themes remain centralized under `src/tui/theme/`. Use semantic palette tokens, never chalk named colors, and do not cache styled functions at module scope. Keep `ColorPalette`, built-in palettes, schema, and required mirrors synchronized when changing tokens.

All selectors and dialogs must follow `DESIGN.md`: `SearchableList`, `SELECT_POINTER`, `CURRENT_MARK`, two-border layout, width truncation, Kitty-safe printable keys, and deterministic render/input tests.

## Test placement and verification

- Daemon coordinator, commands, client, socket, pagination, attachments, transcript state, and lifecycle tests → `test/tui/daemon/`.
- Interaction adapter tests → `test/tui/interactions/`.
- Component tests remain under `test/tui/components/`.
- Run focused daemon/run-shell tests, `@kiki/cli` and `@kiki/session-core` typechecks, remaining TUI tests, printable-key/color guards, and `git diff --check`.
- Real TTY behavior may remain a stated manual residual; do not replace it with a fake terminal assertion that does not exercise the contract.
