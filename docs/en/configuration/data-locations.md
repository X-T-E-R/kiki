# Data locations

Kiki stores all runtime data — the config file, session history, login credentials, and diagnostic logs — under `~/.kiki/`. This page helps you understand where each type of data lives, what it is for, and how to clean up or relocate it when needed.

## Data root directory

The default data root is `~/.kiki/`. The actual path varies by platform:

- macOS: `/Users/<name>/.kiki`
- Linux: `/home/<name>/.kiki`
- Windows: `C:\Users\<name>\.kiki`

If you need to move the data directory elsewhere (for example, to isolate configs for different projects with independent environments), set `KIKI_HOME`:

```sh
export KIKI_HOME="$HOME/.config/kiki"
```

Once set, **all** Kiki Code data — config, sessions, logs, OAuth credentials, Kiki-specific user Skills, global `AGENTS.md`, and more — lands under the new path. For the full reference on `KIKI_HOME`, see [Environment variables](./env-vars.md).

::: tip Note

**Generic `.agents` resources** stay under the real OS home so they can be shared across tools. For example, user-level generic Skills remain at `~/.agents/skills/`, while Kiki-specific user Skills move with `KIKI_HOME` as `$KIKI_HOME/skills/`.
:::

## Directory layout

```
$KIKI_HOME  (default: ~/.kiki)
├── config.toml             # User configuration
├── tui.toml                # Terminal UI preferences (including auto-update toggle)
├── AGENTS.md               # Global Kiki-specific agent instructions (optional)
├── mcp.json                # User-level MCP server declarations (optional)
├── skills/                 # Kiki-specific user-level Skills (optional)
├── plugins/
│   ├── installed.json      # Installed plugin records and enabled state
│   └── managed/            # Plugin copies installed from zip/local paths
├── session_index.jsonl     # Session index
├── credentials/            # OAuth credentials (dir 0700, files 0600)
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # Session data (see below)
│   └── <workDirKey>/<sessionId>/
├── bin/
│   ├── rg                  # managed ripgrep binary for Grep (rg.exe on Windows)
│   └── fd                  # managed fd binary for file references (fd.exe on Windows)
├── logs/
│   └── kimi-code.log       # Global diagnostic log
└── user-history/
    └── <md5(workDir)>.jsonl
```

## File descriptions

Each top-level file under the data root serves a specific purpose; most are managed automatically by the CLI:

- **`config.toml`**: the main runtime configuration file, storing user-level settings such as providers, models, and loop control. See [Configuration files](./config-files.md).
- **`tui.toml`**: terminal UI client preferences such as theme, editor, notifications, and status line.
- **`AGENTS.md`**: global Kiki-specific agent instructions. This file moves with `KIKI_HOME`; generic cross-tool instructions can still live under `~/.agents/AGENTS.md`.
- **`mcp.json`**: user-level MCP server declarations, merged with the project-local `.kiki/mcp.json` on startup. See [MCP](../customization/mcp.md).
- **`skills/`**: Kiki-specific user-level Skills. This directory moves with `KIKI_HOME`; generic cross-tool Skills can still live under `~/.agents/skills/`. See [Agent Skills](../customization/skills.md).
- **`plugins/installed.json`**: records installed plugins, each plugin's enabled state, and MCP server capability state changes made via `/plugins` or `/plugins mcp disable|enable`. Files installed from local paths or zip URLs are copied to `plugins/managed/<id>/`. See [Plugins](../customization/plugins.md).
- **`credentials/`**: OAuth credential directory, with permissions `0o700` (directory) / `0o600` (files), readable and writable only by the current user. Managed provider credentials are stored as `credentials/<name>.json`; MCP server credentials are stored under `credentials/mcp/`. Credentials are written using an atomic flow (tmp → fsync → rename) to prevent corruption.

## Session data

Each session's data is stored under `sessions/<workDirKey>/<sessionId>/`, and a top-level `session_index.jsonl` index is maintained (one record per line, each containing `sessionId`, `sessionDir`, and `workDir`). `workDirKey` is a bucket name derived from the working directory path, in the format `wd_<slug>_<first-12-chars-of-sha256>`.

Inside each session directory:

- **`state.json`**: session metadata including title, `lastPrompt`, creation/update timestamps, and `forkedFrom`.
- **`upcoming-goals.json`**: the TUI-only queue created by `/goal next <objective>`. It is not part of the agent conversation until a queued goal is promoted after the current goal completes.
- **`agents/main/wire.jsonl`**: the main Agent's complete communication record, used for session resumption and replay.
- **`agents/main/plans/`**: plan files written in Plan mode, named by plan id (`<id>.md`).
- **`agents/agent-0/` etc.**: sub-Agent instance directories, each containing their own `wire.jsonl`.
- **`logs/kimi-code.log`**: diagnostic log for this session; only present when a diagnostic event occurs.
- **`tasks/`**: background task persistence — `tasks/<task_id>.json` stores status/pid/exit code; `tasks/<task_id>/output.log` stores output.
- **`cron/`**: scheduled task persistence; reloaded into the scheduler when the session is resumed with `kiki --session`. See [Scheduled tasks](../reference/tools.md#scheduled-tasks).

## Built-in tool cache

The first time the `Grep` tool needs ripgrep, the CLI can automatically download `rg` and cache it at `bin/rg` (`bin/rg.exe` on Windows). File-reference completion in the terminal UI uses `fd`; the CLI downloads and caches it at `bin/fd` (`bin/fd.exe` on Windows) in the background when needed. Subsequent runs reuse the cached binaries. `rg` prefers the system `PATH` before the cache, while `fd` checks the managed cache before falling back to system `fd` / `fdfind`. Deleting the `bin/` directory triggers a fresh download on the next use.

## Logs

- **`logs/kimi-code.log`** (global): records startup, login, export, and other cross-session events.
- **`<sessionDir>/logs/kimi-code.log`** (session-level): records diagnostic events within a single session.

When reporting a bug, prefer exporting the relevant session with `kiki export` (see [kiki command](../reference/kimi-command.md)); the session log is included in the export by default. Add `--no-include-global-log` if you do not want to share the global log.

## Input history

Terminal input history is saved separately per working directory, at `user-history/<md5(workDir)>.jsonl`. It is used to browse previously typed prompts in the terminal UI using the arrow keys.

## Clearing data

Deleting the data root directory (`~/.kiki/` or the path set by `KIKI_HOME`) removes all runtime data. To clear only part of the data:

| Goal | Action |
| --- | --- |
| Reset configuration | Delete `~/.kiki/config.toml` |
| Reset terminal UI preferences | Delete `~/.kiki/tui.toml` |
| Clear all sessions | Delete `~/.kiki/sessions/` and `session_index.jsonl` |
| Clear diagnostic logs | Delete `~/.kiki/logs/` |
| Clear input history | Delete `~/.kiki/user-history/` |
| Force re-download of managed `rg` and `fd` | Delete `~/.kiki/bin/` |
| Clear provider OAuth login state | Run `/logout`, or delete the corresponding `credentials/<name>.json` |
| Clear MCP server OAuth login state | Delete `credentials/mcp/` (`/logout` does not clear MCP credentials) |
| Remove user-level MCP declarations | Delete `$KIKI_HOME/mcp.json` (default `~/.kiki/mcp.json`) |
| Clear global Kiki-specific agent instructions | Delete `$KIKI_HOME/AGENTS.md` (default `~/.kiki/AGENTS.md`) |
| Clear plugin install records | Delete `$KIKI_HOME/plugins/` (local plugin source directories are not affected) |
| Clear Kiki-specific user-level Skills | Delete `$KIKI_HOME/skills/` (default `~/.kiki/skills/`) |

## Next steps

- [Configuration files](./config-files.md) — full reference for `config.toml` fields
- [Environment variables](./env-vars.md) — detailed usage of `KIKI_HOME` and related path variables
