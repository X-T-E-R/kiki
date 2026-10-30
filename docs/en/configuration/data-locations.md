# Data locations

Kiki stores its runtime data — the config files, session history, login credentials, and diagnostic logs — under `<home>` on the server host. `<home>` means the current Space's resolved Kiki home; `~/.kiki/` is only the default when no supported explicit `--home` or `KIKI_HOME` selects another path. This page helps you understand where each type of data lives, what it is for, and how to clean up or relocate it when needed.

::: warning Desktop OAuth credentials have a separate default
When no supported explicit `--home` is selected and `KIKI_HOME` is unset, the desktop app keeps its runtime data (config, sessions, `server.token`) in `~/.kiki/`, but its OAuth credentials default to the compatibility home `~/.kimi-code/` (`~/.kimi-code/credentials/`). If you already have a Moonshot `~/.kimi-code/credentials/kimi-code.json`, the desktop app uses that token instead of starting logged out — and deleting `~/.kiki/` does **not** clear it. Running `kiki login` writes the token to `~/.kiki/credentials/`, so a daemon started outside the desktop environment does not see the desktop's credentials.

Setting `KIKI_HOME` moves the runtime data and desktop OAuth credentials selected by that home. The desktop app also lets you pick the compatibility home in its settings. The kimi-cli-era `~/.kimi` directory is never read and is not imported.
:::

## Data root directory

The default data root is `~/.kiki/`. The actual path varies by platform:

- macOS: `/Users/<name>/.kiki`
- Linux: `/home/<name>/.kiki`
- Windows: `C:\Users\<name>\.kiki`

If you need to move the data directory elsewhere (for example, to isolate configs for different projects with independent environments), set `KIKI_HOME`:

```sh
export KIKI_HOME="$HOME/.config/kiki"
```

Once resolved, current config, sessions, memory, logs, and other runtime data belong under `<home>`. A base home can supply selected inherited resources, and shared credentials may use that base when configured; this does not mean every Kiki file moves to or is shared from the same path. For shell paths, quote the current home as `"$KIKI_HOME/..."` when that environment variable names `<home>`. For the full reference on `KIKI_HOME`, see [Environment variables](./env-vars.md).

::: tip Note

**Generic `.agents` resources** stay under the real OS home so they can be shared across tools. For example, user-level generic Skills remain at `~/.agents/skills/`, while Kiki-specific user Skills move with the current home as `"$KIKI_HOME/skills/"` when `KIKI_HOME` names it.
:::

## Directory layout

```text
$KIKI_HOME  (default: ~/.kiki)
├── config.toml             # User configuration
├── tui.toml                # Terminal UI preferences
├── AGENTS.md               # Global Kiki-specific agent instructions (optional)
├── mcp.json                # User-level MCP server declarations (optional)
├── skills/                 # Kiki-specific user-level Skills (optional)
├── cognition/              # Prompt files referenced by [models."<alias>".cognition] (optional; see Configuration files)
├── hooks/                  # Script files referenced by [[hooks]] command paths (optional; see Hooks)
├── plugins/
│   ├── installed.json      # Installed plugin records and enabled state
│   └── managed/            # Plugin copies installed from zip/local paths
├── session_index.jsonl     # Session index
├── workspaces.json          # Registered workspace names and roots
├── workspaces/              # Automatically created workspace directories
│   └── <date>-<id>/
├── credentials/            # Restricted credentials (dir 0700, files 0600)
│   ├── credentials.toml     # Provider API keys
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # Session data (see below)
│   └── <workDirKey>/<sessionId>/
├── store/
│   └── thread-mailbox-sqlite-v1/ # Canonical mailbox and upgrade recovery copies
├── server/
│   └── events/             # Bounded client event replay journals
├── bin/
│   ├── rg                  # managed ripgrep binary for Grep (rg.exe on Windows)
│   └── fd                  # managed fd binary for file references (fd.exe on Windows)
├── logs/
│   └── kimi-code.log       # Global diagnostic log
└── user-history/
    └── <md5(workDir)>.jsonl
```

## File descriptions

Each file under the data root serves a specific purpose; most are managed automatically by the CLI:

- **`config.toml`**: the main runtime configuration file, storing user-level settings such as providers, models, and loop control. Provider API keys live in `credentials/credentials.toml`. See [Configuration files](./config-files.md).
- **`credentials/credentials.toml`**: holds provider credentials such as each provider's `api_key`. On a shared TOML path a value here overrides `config.toml`, and credentials left in an older `config.toml` are migrated here on first load, with the previous file kept as `config.toml.bak-<date>` — that backup still contains your keys in plaintext, so delete it once you have checked the migration. Kiki requests owner-only permissions (`0o600`) where supported. See [Provider credentials](./config-files.md#provider-credentials).
- **`tui.toml`**: terminal UI client preferences such as theme, editor, notifications, and status line.
- **`AGENTS.md`**: user-level agent instructions. This file moves with `KIKI_HOME` and is combined with workspace-root instructions unless `.kiki/AGENTS.md` overrides it.
- **`mcp.json`**: user-level MCP server declarations, merged with the project-local `.kiki/mcp.json` on startup. See [MCP](../server/mcp.md).
- **`skills/`**: Kiki-specific user-level Skills. This directory moves with `KIKI_HOME`; generic cross-tool Skills can still live under `~/.agents/skills/`. See [Agent Skills](../customization/skills.md).
- **`cognition/`**: prompt files referenced by `[models."<alias>".cognition]`; paths are relative to the data root. See [Model cognition](./config-files.md#model-cognition).
- **`hooks/`**: script files referenced by `[[hooks]]` command paths (for example `node "$KIKI_HOME/hooks/check-bash.mjs"` for the current home). See [Hooks](../customization/hooks.md).
- **`plugins/installed.json`**: records installed plugins, each plugin's enabled state, and MCP server capability state changes made via `/plugins` or `/plugins mcp disable|enable`. Files installed from local paths or zip URLs are copied to `plugins/managed/<id>/`. See [Plugins](../customization/plugins.md).
- **`credentials/`**: restricted credential directory, with requested permissions `0o700` (directory) / `0o600` (files). OAuth logins for managed providers are stored as `credentials/<name>.json`; MCP server credentials are stored under `credentials/mcp/`. On Windows, check the file and parent-directory ACLs yourself before relying on the file to stay private.
- **`workspaces.json` and `workspaces/`**: the registered workspace catalog and the project directories Kiki creates when a new session has no selected workspace. Each automatically created session receives a distinct directory; these are working files, separate from the session history under `sessions/`.

## Session data

Each session's data is stored under `sessions/<workDirKey>/<sessionId>/`, and a top-level `session_index.jsonl` index is maintained (one record per line, each containing `sessionId`, `sessionDir`, and `workDir`). `workDirKey` is a bucket name derived from the working directory path, in the format `wd_<slug>_<first-12-chars-of-sha256>`.

Inside each session directory:

- **`state.json`**: session metadata including title, `lastPrompt`, creation/update timestamps, and `forkedFrom`.
- **`upcoming-goals.json`**: the TUI-only queue created by `/goal next <objective>`. It is not part of the agent conversation until a queued goal is promoted after the current goal completes.
- **`agents/main/wire.jsonl`**: the main Agent's complete communication record, used for session resumption and replay. [`kiki session seal`](../reference/command.md#kiki-session) leaves this file in place, so its size does not drop; [`kiki session unseal`](../reference/command.md#kiki-session) removes the seal without modifying the file.
- **`agents/main/plans/`**: plan files written in Plan mode, named by plan id (`<id>.md`).
- **`agents/agent-0/` etc.**: sub-Agent instance directories, each containing their own `wire.jsonl`.
- **`logs/kimi-code.log`**: diagnostic log for this session; only present when a diagnostic event occurs.
- **`tasks/`**: background task persistence — `tasks/<task_id>.json` stores status/pid/exit code; `tasks/<task_id>/output.log` stores output.
- **`cron/`**: scheduled task persistence; reloaded into the scheduler when the session is resumed with `kiki --session`. See [Scheduled tasks](../reference/tools.md#scheduled-tasks).

## Server event replay

`server/events/<sessionId>.jsonl` stores durable events for reconnecting clients, not the complete conversation history. Kiki automatically retains the session's replay window (1000 events by default). Active writers compact after growing beyond two windows and retain one window when closing; this limits event count, not bytes, and keeps oversized events intact.

Older journals shrink when the new writer first appends to them. Browsing a cold session only reads its watermark and does not rewrite the journal; journals for inactive or deleted sessions therefore remain until written again or explicitly cleared. Failed replacement leaves the durable source intact and logs a warning, with reclamation retried on later writes or writer close.

This retention does not remove `sessions/`, agent `wire.jsonl` files, or saved media. Clients whose cursor is no longer covered recover through a snapshot/reset rather than replaying the old event sequence; see [Reconnect and recovery](../server/rest-api.md#reconnect-and-recovery). If you need to clear old journals manually, first stop every Kiki server using this data root, then clear only `server/events/` and restart. Never delete or truncate these journals while a writer is running.

## Canonical mailbox

`store/thread-mailbox-sqlite-v1/` contains durable peer messages, delivery state, idempotency receipts, activity cursors, and workspace overrides. Unlike the search and query caches, these records are authoritative and must not be deleted to trigger a rebuild. `authority.json` selects `mailbox-<migrationId>.sqlite`; keep the adjacent `-wal` and `-shm` files while it is open. Use [`kiki storage backup`](../reference/command.md#kiki-storage) for a consistent SQLite copy instead of copying only a live `.sqlite` file.

The 0.5.x upgrade retains its checkpoint in `migration.json`, frozen source copies under `recovery/<migrationId>/sources/`, and moved originals under `recovery/<migrationId>/originals/`. The former `store/thread-mailbox-v3`, `store/thread-mailbox-v1`, and `store/agent-collaboration-mailbox-v2` directory names become fence files. Keep the originals and fences: older versions must not reopen those locations as writable mailboxes, and the originals also retain older activity records. Do not point an old binary at the recovery copies. Run `kiki storage status` to inspect recovery state and `kiki storage migrate` to resume. After rollback is no longer possible, [`kiki storage cleanup-recovery`](../reference/command.md#kiki-storage) can preview and, with a verified independent SQLite backup and explicit confirmation, remove only `sources/` files that match the originals. Never remove these directories manually; follow the [storage command's rollback rules](../reference/command.md#kiki-storage) rather than moving originals back by hand.

## Session and usage query cache

`cache/query-store-sqlite-v1/index.sqlite` holds the SQLite query cache for session lists and thread-turn lookups. Usage facts and source coverage use a separate database at `cache/usage-read-model-v2/index.sqlite`. Kiki rebuilds these views from session metadata, usage-fact journals, retained accounting ledgers, and conversation history when needed. Each open database may have adjacent `-wal` and `-shm` files.

If one cache is damaged, stop every Kiki process using the data root, back up and remove only that cache directory, then restart. Rebuilding a large Usage history can take several requests; committed import progress survives a restart. Keep `cache/usage-facts-v1/`, `sessions/`, and `store/`: they contain the journals and records needed for recovery. Older generic Usage collections and `cache/query-store-v*/` directories are retained for rollback; do not remove the shared query database to reset Usage.

## Content search index

Content search uses SQLite at `search-index-v2/index.sqlite`. Kiki reuses a compatible index or rebuilds an older recognized search schema from session metadata and conversation history; results may be incomplete while rebuilding. This cache rebuild does not change the source history. The older MiniDb `search-index/` directory is left intact and is neither imported nor used as a fallback. Keep `sessions/` and `store/`: rebuilding a search cache does not replace the separate mailbox storage upgrade.

In the 0.5 migration series, an explicit `search_backend = "minidb"` in `config.toml` or `KIKI_SEARCH_BACKEND=minidb` is a deprecated alias for SQLite and produces a migration warning. Remove the old setting, or change it to `sqlite`, before upgrading to 0.6, which retires that value. Environment selection takes precedence over `search_backend`; Kiki does not rewrite either setting. The old `search_worker` experimental switch has been removed because SQLite always isolates database work in its writer process and query worker.

Search is available by default. `[search] enabled = false`, `KIKI_SEARCH_DISABLED=1`, or an explicit desktop `desktop_search = false` keeps it off; the migration alias does not start a worker or rebuild the cache when search is disabled. Set `[search] index_subagents = true` to include subagent content; it is off by default. These settings take effect after restarting Kiki. Search matches user and assistant text and session titles by default; tool-result output is included only when explicitly requested. Thinking, tool names, and tool-call arguments stay excluded.

## Built-in tool cache

The first time the `Grep` tool needs ripgrep, the CLI can automatically download `rg` and cache it at `bin/rg` (`bin/rg.exe` on Windows). File-reference completion in the terminal UI uses `fd`; the CLI downloads and caches it at `bin/fd` (`bin/fd.exe` on Windows) in the background when needed. Subsequent runs reuse the cached binaries. `rg` prefers the system `PATH` before the cache, while `fd` checks the managed cache before falling back to system `fd` / `fdfind`. Deleting the `bin/` directory triggers a fresh download on the next use.

## Logs

- **`logs/kimi-code.log`** (global): records startup, login, export, and other cross-session events.
- **`<sessionDir>/logs/kimi-code.log`** (session-level): records diagnostic events within a single session.

When reporting a bug, prefer exporting the relevant session with `kiki export` (see [kiki command](../reference/command.md)); the session log is included in the export by default. Add `--no-include-global-log` if you do not want to share the global log.

## Input history

Terminal input history is saved separately per working directory, at `user-history/<md5(workDir)>.jsonl`. It is used to browse previously typed prompts in the terminal UI using the arrow keys.

## Clearing data

Deleting the data root directory (`~/.kiki/` or the path set by `KIKI_HOME`) removes all runtime data, **including files in automatically created workspaces**. Back up those working files before deleting the root. Archiving a session or unregistering its workspace does not delete its working directory; clearing only `sessions/` also leaves `workspaces/` intact. With `KIKI_HOME` unset and the desktop compatibility home left at its default, the desktop OAuth credentials live under `~/.kimi-code/credentials/` (see the note at the top of this page) and are **not** removed by deleting `~/.kiki/`. To clear only part of the data:

| Goal | Action |
| --- | --- |
| Reset configuration | Delete `~/.kiki/config.toml` |
| Reset provider credentials | Delete `~/.kiki/credentials/credentials.toml` (also remove the old `~/.kiki/credentials.toml` if still present, or it will be migrated again on startup) |
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
