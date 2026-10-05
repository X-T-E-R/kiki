# Keyboard Shortcuts

Kiki's TUI shortcuts are grouped by context: general input, mode switching, editing, streaming, tool output, approval panels, and help navigation. Type `/help` to browse command usage, descriptions, support status, and input shortcuts.

## General Shortcuts

The following keys are always available in the input box:

| Shortcut | Function |
| --- | --- |
| `Enter` | Submit the current input |
| `Shift-Enter` / `Ctrl-J` | Insert a newline in the input |
| `↑` / `↓` | Browse input history |
| `Esc` | Close a popup / cancel completion / interrupt streaming output or context compaction |
| `Ctrl-C` | Interrupt the current streaming output, or clear the input box |
| `Ctrl-D` | Exit Kiki when the input box is empty |
| `Ctrl-T` | Expand or collapse the todo list when it is truncated |

During streaming, `Ctrl-C` clears a nonempty draft first. With the input box empty, it interrupts the active turn without a second confirmation.

**Exiting the program** (pressing `Ctrl-C` with an empty input box, or pressing `Ctrl-D`) uses a double-press confirmation mechanism: after the first press, a prompt appears in the status bar; a second press of the same key actually exits. Pressing any other key in between clears the confirmation state.

## Mode Switching

| Shortcut | Function |
| --- | --- |
| `Shift-Tab` | Toggle Plan mode |
| `!` | Enter shell mode (in an empty input box) |

Press `Shift-Tab` to enable or disable Plan mode. When enabled, the Agent prioritizes read-only tools for research and planning and can write to the current plan file; `Bash` is subject to the current permission mode and regular rules, without any additional separate approval triggered by Plan mode. Simply toggling does not create an empty plan file. Press `Shift-Tab` again to exit Plan mode.

Type `!` in an empty input box to enter shell mode and run terminal commands directly. See [Interaction and input](../guides/interaction.md#shell-mode).

## Input & Editing

| Shortcut | Function |
| --- | --- |
| `Ctrl-G` | Edit the current input in an external editor |
| `Ctrl-V` | Paste an image or video from the clipboard (Unix / macOS) |
| `Alt-V` | Paste an image or video from the clipboard (Windows) |
| `Ctrl--` | Undo input edits, including a draft cleared with `Ctrl-C` |

Use `/undo` to undo the last conversation turn; `Ctrl--` only edits the input box.

Pressing `Ctrl-G` opens an external editor, selected according to the following priority:

1. The editor configured via the `/editor` command
2. The `$VISUAL` environment variable
3. The `$EDITOR` environment variable

After saving and exiting, the edited content replaces the input box; exiting without saving leaves the input unchanged.

When pasting an image or video, a placeholder is shown in the input box — the actual media data is sent to the model when the message is submitted. The system clipboard is read first; on Linux, Wayland and X11 are tried; on WSL, PowerShell is also used as a fallback to read the Windows clipboard.

## During Streaming

While streaming output is active, the input box can still receive input and supports the following additional operations:

| Shortcut | Function |
| --- | --- |
| `Esc` | Interrupt the current streaming output |
| `Ctrl-C` | Clear a nonempty draft first; interrupt the active turn when the input is empty |
| `Ctrl-S` | Steer the running turn: send the queued messages and the current draft into it now instead of waiting for the turn to end |
| `Ctrl-B` | Move the running turn to the background, leaving you free to queue the next instruction |

`Ctrl-S` steers in queue order. Shell commands (`! …`) and inline Skill invocations are never steered in — they stay queued and run after the current turn, and everything queued behind such an item waits with them.

Both shortcuts are unavailable in the daemon TUI (`kiki web`), which reports them as disabled.

## Tool Output

| Shortcut | Function |
| --- | --- |
| `Ctrl-O` | Expand or collapse tool output |

When collapsed tool call results exist in the history, press `Ctrl-O` to toggle between collapsed and expanded views.

## Approval Panel

When the Agent initiates a tool call that requires confirmation, the TUI displays an approval panel. For the full approval workflow, see [Interaction & Input](../guides/interaction.md#approval-flow). The available keys inside the panel are:

| Shortcut | Function |
| --- | --- |
| `↑` / `↓` | Move the cursor between candidate options |
| `Enter` | Confirm the currently selected option |
| `1` ~ `9` | Directly select the option at the corresponding index |
| `Esc` / `Ctrl-C` / `Ctrl-D` | Reject the current request |
| `Ctrl-E` | Expand or collapse the full content when the panel contains a diff or file preview |
| `Ctrl-O` | Toggle the collapsed state of other tool output |

Options that require feedback (such as "Reject" or "Revise") switch to a feedback input state after confirmation: type the feedback text and press `Enter` to submit; press `Esc` to exit feedback input and return to the candidate list.

## Popup Mode

`/help` opens a scrollable reference in place of the input box. Command usage and descriptions wrap to fit the terminal width; closing it returns to the unchanged input draft. Use these keys inside the help panel:

| Shortcut | Function |
| --- | --- |
| `↑` / `↓` | Scroll one line at a time |
| `PageUp` / `PageDown` | Scroll 10 lines at a time |
| `Esc` / `Enter` / `q` / `Q` | Close the panel |

## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for built-in TUI control commands
- [`kiki` Command](./command.md) — Complete reference for startup flags and subcommands
