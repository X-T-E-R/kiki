# Interaction and input

The CLI and TUI are a terminal interface built from the input box, the conversation view, and the status bar. This page covers typing and pasting, the approval flow, and the modes you can switch between.

## Input box basics

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. When it is empty, `↑` / `↓` browse what you have typed before in this working directory, shell commands included.

**Leaving the CLI**: `Ctrl-D` with an empty input box, `Ctrl-C` twice while idle, or `/exit`. All three need the agent to be idle — during streaming output, `Ctrl-C` and `Esc` only interrupt the current turn.

## Pasting images and video

You can paste images and video straight into the input box, so a screenshot, UI mockup, architecture diagram or code demo can go into the conversation without uploading or converting anything first.

How to paste:

- **macOS / Linux**: `Ctrl-V`
- **Windows**: `Alt-V`

The pasted media shows up as an editable placeholder; on send, the real content replaces it. A plain-text clipboard just pastes as text. Whether media works at all depends on the current model accepting image / video input (the `image_in` / `video_in` capability fields); it is enabled by default on a Kimi Code account.

## Slash commands

Anything starting with `/` is treated as a slash command. Typing `/` opens a completion menu that filters in real time as you keep typing; press `Esc` to close the menu. If nothing matches, the input is sent to the agent as a regular message.

Active [Agent Skills](../customization/skills.md) (skill packages that extend what the agent can do) are registered as slash commands. Ordinary external skills are invoked with `/skill:<name>`, external sub-skills appear as dotted commands such as `/parent.child`, and built-in skills appear directly as `/<name>`. When an external skill name does not clash with a system command, you can drop the `skill:` prefix and type `/<name>`.

Inside a longer prompt, typing `/` after whitespace — including at the start of a later line — opens a skill-only completion menu. Reference several skills in one prompt that way: Kiki activates them together and runs them as a single turn, and one `/undo` reverts the whole submission. A skill mentioned inside a prompt is activated by name only and cannot carry arguments; arguments still need a standalone `/skill:<name> args`. Built-in and plugin commands only work at the very start of the input.

Some commands need the agent to be idle — press `Esc` to interrupt streaming output or context compression first. Mode toggles and queries like `/yolo`, `/plan`, `/help` and `/btw` are always available. [Slash commands reference](../reference/slash-commands.md) has the full list.

## File references

Type `@` to get file-path completion. Picking a path inserts its relative form into your message, and the agent reads the file when it picks up that message. It works in git and non-git directories alike, and folder suggestions end with `/` so you can keep completing paths inside them. While Kiki's fast file-search component is still downloading in the background, completion falls back to a plain filesystem scan. Hidden paths are suggested; `.git` is not.

> `@` references and slash commands are two separate mechanisms: `@` gives the agent file context, while `/` invokes built-in features or Skills. After whitespace, `/` offers Skill completions only; use a leading `/` for built-in and plugin commands.

## Approval flow

When a tool call has side effects — running a command, writing outside the workspace trust boundary — the TUI shows an approval panel. In a trusted working directory, `Write` / `Edit` inside it run without a per-file prompt; in manual mode, shell commands, writes outside the workspace, links to external targets and sensitive files all ask first. YOLO mode does not prompt for ordinary tool calls, and neither does Plan mode for writes to plan files.

Use the arrow keys and `Enter`, or press `1` / `2` / `3` to pick by number. `Esc`, `Ctrl-C`, and `Ctrl-D` all mean reject.

The panel usually offers **Approve for this session**, which approves that kind of call for the rest of the session. For rules that outlive a session, add allow / deny entries in [Configuration files](../configuration/config-files.md#permission).

## Mode switching

### Plan mode

In Plan mode the agent first outputs an action plan and waits for your approval before modifying any files — useful for complex or high-risk tasks.

- Toggle: `Shift-Tab` or `/plan`
- Clear the current plan: `/plan clear` (only while idle)

After writing the plan the agent pauses for you: approve it, reject it, or ask for changes. Leaving Plan mode asks for confirmation even when YOLO mode is on — except in Auto and Approve for me, where the exit is approved for you and marked "Auto-approved" in the transcript.

### Permission modes

`/permission` switches between Manual, Auto, Approve for me, and YOLO.

**YOLO mode** (`/yolo`) approves agent file access without asking, including sensitive targets such as `.env` or SSH keys. An explicit deny rule still wins, and Git-control paths may still prompt. Leaving Plan mode still asks, and the agent can still put questions to you.

**Auto mode** (`/auto`) approves ordinary tool actions and plan exits without prompting, and asks before sensitive files and workspace links to external targets. Explicit deny rules still block matching calls, and dangerous Bash commands still request approval unless that guard is turned off.

**Approve for me** (`review`) works like Auto but sends policy-generated approval requests to a [configured reviewer](../configuration/config-files.md#reviewer-approval) first. An explicit `ask` rule always comes to you instead. A confident reviewer decision is recorded with the reviewer's attribution; an uncertain or unavailable one falls back to your approval panel, and after three reviewer denials in a turn the rest of that turn's requests come straight to you. Agent questions are separate from reviewer decisions, and [the interaction setting](../configuration/config-files.md#interaction) decides whether a question blocks the turn.

With no approval client attached — an unattended scheduled run, for instance — a request that would need you is cancelled rather than granted, and a question is dismissed rather than left hanging.

::: warning
YOLO mode skips confirmation for file writes and command execution. Only use it in working directories you trust.
:::

### Shell mode

Shell mode runs terminal commands without leaving the conversation. Their output goes into the conversation context, so the agent can see the results in later turns.

- Enter: type `!` in an empty input box, or paste a command starting with `!`.
- Exit: press `Backspace` or `Esc` in an empty input box. Submitting a command also returns you to normal mode.
- Recall previous commands: with the input box empty in shell mode, press `↑`; recalling one keeps you in shell mode so it runs again as a command.

The input box shows a `!` prompt on the left in shell mode (in the desktop GUI the border turns violet too). `!git status` checks the repository without opening another terminal, and its output lands in the conversation.

## During streaming output

The input box remains usable while the agent is thinking or calling tools, and supports the following extra actions:

- **`Ctrl-S`**: inject the content in the input box into the running turn immediately, without waiting for it to finish
- **`Esc` / `Ctrl-C`**: interrupt the current turn
- **`Ctrl-O`**: globally toggle the collapsed/expanded state of tool output and compaction summaries

## External editor

`Ctrl-G` sends the current input to an external editor. Save and close to write the text back into the input box; close without saving and the original stays. This is the easy way to enter long or heavily formatted text.

Kiki picks the editor in this order: the `/editor` config, then `$VISUAL`, then `$EDITOR`. With none of them set, run `/editor` to choose one.

## Next steps

- [Keyboard shortcuts](../reference/keyboard.md) — full quick-reference table of all shortcuts
- [Slash commands](../reference/slash-commands.md) — all built-in commands with descriptions and aliases
- [Sessions and context](/en/guides/sessions) — how to resume sessions, compress context, and export conversations
