# Interaction and input

The Kiki CLI and TUI run as an interactive terminal user interface built around three components: the input box, the conversation view, and the status bar. This page covers how to enter text, paste media, navigate the approval flow, and switch between modes.

## Input box basics

The input box accepts free-form text. Press `Enter` to send, or `Shift-Enter` / `Ctrl-J` to insert a newline. When the input box is empty, press `↑` / `↓` to browse the input history for the current working directory, including previous shell commands.

**Exiting the CLI**: press `Ctrl-D` with the input box empty, press `Ctrl-C` twice while idle, or type `/exit`. All three require the agent to be idle — pressing `Ctrl-C` or `Esc` during streaming output only interrupts the current turn, it does not exit the program.

## Pasting images and video

Kiki supports pasting images and video directly into the input box, so you can discuss screenshots, UI mockups, architecture diagrams, or code demos without uploading or converting files first.

**Video input is a distinctive Kiki capability** — you can paste a video clip and have the model analyze its content, UI flow, or code walkthrough.

How to paste:

- **macOS / Linux**: `Ctrl-V`
- **Windows**: `Alt-V`

After pasting, the input box shows a placeholder that you can edit like normal text; on submit, the placeholder is replaced with the actual content. A plain-text clipboard falls back to ordinary paste. Media support depends on whether the current model accepts image / video input (the model capability fields `image_in` / `video_in`); it is enabled by default when you are logged in to a Kimi Code account.

## Slash commands

Anything starting with `/` is treated as a slash command. Typing `/` opens a completion menu that filters in real time as you keep typing; press `Esc` to close the menu. If nothing matches, the input is sent to the agent as a regular message.

Active [Agent Skills](../customization/skills.md) (skill packages that extend what the agent can do) are automatically registered as slash commands: ordinary external Skills are invoked with `/skill:<name>`, external sub-skills appear as dotted commands such as `/parent.child`, and built-in Skills appear directly as `/<name>` in the slash command panel. If an external skill name does not conflict with a system slash command, you can also drop the `skill:` prefix and type `/<name>` directly.

Inside a longer prompt, typing `/` after whitespace — including at the start of a later line — opens a skill-only completion menu. You can reference several Skills in one prompt this way: Kiki activates them together and runs them with the prompt as a single turn (one `/undo`, which reverts the previous turn's output, undoes the whole submission), and the prompt text is sent unchanged. A Skill mention in a prompt never carries arguments — activation is by name only; arguments remain a standalone `/skill:<name> args` concept. Built-in and plugin commands still only work at the very start of the input.

Some commands are only available when the agent is idle — you need to press `Esc` to interrupt streaming output or context compression before using them. Mode-toggle and query commands like `/yolo`, `/plan`, `/help`, and `/btw` are always available. For the full list, see [Slash commands reference](../reference/slash-commands.md).

## File references

Type `@` to trigger file-path completion. Selecting a path inserts its relative form into your message; the agent loads the file content directly when it reads the message. File references work in both git and non-git directories, and folder suggestions end with `/` so you can keep completing paths inside them. While Kiki's fast file-search component is still downloading in the background, Kiki falls back to a basic filesystem scan. Hidden paths are available, but `.git` is excluded from suggestions.

> `@` references and slash commands are two separate mechanisms: `@` gives the agent file context, while `/` invokes built-in features or Skills. After whitespace, `/` offers Skill completions only; use a leading `/` for built-in and plugin commands.

## Approval flow

When the agent calls a tool with side effects — running commands, modifying files outside the workspace trust boundary — the TUI displays an approval panel for your confirmation. In a trusted working directory, `Write` / `Edit` inside that directory run without per-file approval; shell commands, workspace-external writes, workspace links to external targets, and sensitive-file access prompt in manual mode. Approvals are not triggered for regular tool calls in YOLO mode, nor for writes to plan files in Plan mode.

Use the arrow keys to select an option and press `Enter` to confirm, or press `1` / `2` / `3` to select by number directly. `Esc`, `Ctrl-C`, and `Ctrl-D` are all equivalent to rejecting.

The panel typically includes an **Approve for this session** option; selecting it auto-approves the same kind of call for the rest of the session. For permanent rules, add allow / deny entries in [Configuration files](../configuration/config-files.md#permission).

## Mode switching

### Plan mode

In Plan mode the agent first outputs an action plan and waits for your approval before modifying any files — useful for complex or high-risk tasks.

- Toggle: `Shift-Tab` or `/plan`
- Clear the current plan: `/plan clear` (only while idle)

After producing a plan the agent pauses for your review — you can approve it, reject it, or ask for revisions. Exiting Plan mode requires your confirmation even if YOLO mode is also active. Auto mode is the exception: plan exits are approved automatically and marked as "Auto-approved" in the transcript.

### YOLO / Auto mode

**YOLO mode** (`/yolo`) auto-approves agent file access, including sensitive targets such as `.env` or SSH keys; an explicit deny rule still wins. Exiting Plan mode still requires review, and the agent can still ask you questions.

**Auto mode** (`/auto`) handles ordinary tool approval and plan exits without asking you questions. It refuses agent file access to sensitive targets and workspace links to external targets because nobody is present to approve them. Switch to manual mode to approve the specific target; do not expect Auto mode to silently read a secret.

::: warning
YOLO mode skips confirmation for file writes and command execution. Only use it in working directories you trust.
:::

### Shell mode

Shell mode lets you run terminal commands without leaving the conversation. The command output is written into the conversation context, so the agent can see the results in later turns.

- Enter: type `!` in an empty input box, or paste a command that starts with `!`.
- Exit: press `Backspace` or `Esc` in an empty input box; submitting a command also returns you to normal mode automatically.
- Run in background: while a command is running, press `Ctrl+B` to move it to a background task.
- Recall previous commands: with the input box empty in shell mode, press `↑` to browse earlier shell commands; recalling one keeps you in shell mode so it runs as a command again.

In shell mode the input box shows a `!` prompt on the left (in the desktop GUI the border also turns violet). For example, you can run `!git status` to check the repository state without opening a new terminal — the output goes straight into the conversation context.

## During streaming output

The input box remains usable while the agent is thinking or calling tools, and supports the following extra actions:

- **`Ctrl-S`**: inject the content in the input box into the running turn immediately, without waiting for it to finish
- **`Esc` / `Ctrl-C`**: interrupt the current turn
- **`Ctrl-O`**: globally toggle the collapsed/expanded state of tool output and compaction summaries

## External editor

Press `Ctrl-G` to send the current input content to an external editor. When you save and close, the text is written back into the input box; if you close without saving, the original content is preserved. This is handy when you need to enter large blocks of text or content with complex formatting.

Editor priority: `/editor` config → `$VISUAL` environment variable → `$EDITOR` environment variable. If none are set, run `/editor` first to choose a default.

## Next steps

- [Keyboard shortcuts](../reference/keyboard.md) — full quick-reference table of all shortcuts
- [Slash commands](../reference/slash-commands.md) — all built-in commands with descriptions and aliases
- [Sessions and context](/en/guides/sessions) — how to resume sessions, compress context, and export conversations
