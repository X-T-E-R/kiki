---
name: kiki-ops
description: Kiki product usage and configuration operations — answer how Kiki works from the local docs (查文档/怎么用 Kiki), inspect or edit config.toml / tui.toml settings (配置), create or edit a custom TUI color theme (主题/theme), configure MCP servers and complete MCP OAuth login, import instructions, skills, and MCP settings from Claude Code and Codex (导入), author or repair agent profiles and SYSTEM.md (profile/主智能体档案), and write a well-specified /goal objective (goal/目标). Use when the user asks about Kiki product behavior or configuration, or asks for any of these tasks.
has-sub-skill: true
---

# Kiki ops (kiki-ops)

Kiki's one-stop entry for using and configuring the product: answer product questions from the docs installed with the running version, explain or edit `config.toml` / `tui.toml`, build a custom TUI theme, configure MCP servers, import Claude Code / Codex assets, author agent profiles, and write a well-specified `/goal` objective.

## Topic routing

Load the matching topic before doing the work — call the `Skill` tool with the topic name from the table (for example `skill: "kiki-ops.mcp"`). Load every relevant topic when a request spans several of them. When the user arrived through a slash command, route from the command name and its arguments instead of asking again what they want.

| Topic | Load | Covers |
| --- | --- | --- |
| docs | `kiki-ops.docs` | Answer Kiki product questions (CLI and GUI usage, configuration, slash commands, features, error behavior) from the local docs |
| config | `kiki-ops.config` | Explain, change, or validate `config.toml` (model, provider, permission, hooks) and `tui.toml` (theme, editor, notifications, auto-update); fix a deprecated key or env-var warning |
| theme | `kiki-ops.theme` | Design, write, and apply a custom TUI color theme JSON file |
| mcp | `kiki-ops.mcp` | Add / edit / remove / list `mcp.json` servers, and complete MCP OAuth login |
| import | `kiki-ops.import` | Migrate instructions, skills, and MCP declarations from Claude Code and Codex into Kiki |
| profile | `kiki-ops.profile` | Author or repair agent profile files and `SYSTEM.md` |
| goal | `kiki-ops.goal` | Draft a well-specified `/goal` objective with the user |

## Cross-topic rules

- `<KIKI_HOME>` is the configured Kiki data root (`KIKI_HOME` first, falling back to `~/.kiki`). Resolve the real directory with the topic's Bash snippet before reading or writing anything — **never assume `~/.kiki`**.
- Never edit a live file in place: copy it to a candidate, edit the candidate, validate, then back up the original under a **new timestamped name** (keep every backup) and move the candidate into place.
- Put discrete choices to the user with `AskUserQuestion` when it is available (plain labelled options otherwise); keep free-form questions in plain text.
- Say how the change takes effect — `/reload`, `/reload-tui`, `/theme`, or a new session (`/new`); the topic states which one applies.
