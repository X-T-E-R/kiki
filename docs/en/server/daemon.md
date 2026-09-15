# `kiki` command

`kiki` is the unified CLI entry: interactive terminal sessions, non-interactive `-p` execution, and shared-daemon management use the same command. Its seat and MCP subcommands let external callers such as Cursor, Claude Code, and Codex call Kiki (inbound); they do not configure the external executors that Kiki uses to run subagents (outbound).

## Start or reuse the daemon

Start the daemon in the foreground, or attach to an existing healthy instance and start one when needed:

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki resolves its home directory in this order: an explicit `--home` where supported, `KIKI_HOME`, then `~/.kiki`. Runtime startup does not read the legacy `KIMI_CODE_HOME` setting. The daemon uses one bearer token from `<home>/server.token`. `--idle-exit` defaults to `30m`; active client leases and running dispatches keep the daemon alive. Client leases are renewed through `POST /api/leases`.

## Manage external-caller seats

A seat fixes the workspace, principal, permission mode, model, and thinking effort before an external caller connects:

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

The daemon creates or reuses one seat for each workspace and principal pair. The delegation token is returned only by `seat create`; `seat list` contains non-sensitive identity and configuration fields.

## Install MCP configuration

Install the stdio MCP configuration for a supported client:

```sh
kiki seat install --client cursor --workspace .
kiki seat install --client claude --workspace .
kiki seat install --client codex --workspace .
kiki seat install --client generic --workspace .
```

Cursor writes `~/.cursor/mcp.json`; Claude Code writes the workspace `.mcp.json`; Codex prints a `config.toml` snippet; `generic` prints JSON. An existing `kiki` entry is backed up before replacement.

## Run the stdio MCP edge

For an MCP client that launches commands, configure:

```sh
kiki mcp --workspace <dir>
```

The command ensures the daemon is running, creates or reuses the workspace seat, and runs the MCP stdio edge. The external MCP caller cannot change the bound workspace, permission mode, model credentials, tool surface, or profile definitions.

## Diagnose the connection

Run:

```sh
kiki doctor
```

The report checks daemon reachability, the token-file path and permissions, the seat list, and each seat's permission mode.

## Inspect prompt fields

`kiki prompt-fields` is a read-only surface for discovering prompt fields, validating their configuration, and explaining the value selected for a runtime context; it does not modify `config.toml`, `SYSTEM.md`, agent profiles, or external override files.

**List fields** — `list` prints every registered field with its owner, consumers, and override policy:

```sh
kiki prompt-fields list
```

**Show a field** — `show` prints one field's default template, empty-value policy, allowed variables, and required placeholders:

```sh
kiki prompt-fields show system.language
```

**Validate configuration** — `validate` checks prompt overrides in the selected config, referenced external TOML files, `SYSTEM.md`, and discovered agent profiles:

```sh
kiki prompt-fields validate --config ./candidate.toml --home ~/.kiki
```

**Explain a value** — `explain` prints a field's `effective`, `shadowed`, or `inactive` status, effective value, and complete source chain for the selected context:

```sh
kiki prompt-fields explain delegation.sub.notice --agent reviewer --model fast --executor native --delegation-position sub
```

Use `--agent <name>`, `--model <alias>`, `--executor <id>`, and `--delegation-position <main|sub|independent>` to select the explanation context. Use `--config <path>` to inspect another config file and `--home <dir>` to select the Kiki home used for `SYSTEM.md`, agent discovery, and relative external override files. Without a subcommand, `kiki prompt-fields` is equivalent to `list`.

The removed `prompt.shared` and `prompt.tools` keys have moved into fields under `[prompt.overrides]`; migrate old entries instead of restoring those keys, following [prompt field precedence](../configuration/overrides.md#prompt-field-precedence).

## Migration from `kimi`

The installed entry point is now `kiki`: run it without a subcommand for the daemon-backed TUI, or use `kiki -p "prompt"` for the existing non-interactive memory path. Daemon, seat, and inbound integration commands are available from the same entry point. The `kimi` bin is no longer installed; update your command launchers.

Run `kiki migrate-config --json` to copy legacy configuration into `KIKI_HOME` or `~/.kiki`. The source is `--from <directory>`, otherwise the legacy `KIMI_CODE_HOME` setting, otherwise `~/.kimi-code`. Only this explicit migration reads that legacy environment variable. Use `--home <directory>` to select the destination. Migration never runs as a side effect of resolving a home path.

Home migration copies `config.toml`, `mcp.json`, `tui.toml`, `SYSTEM.md`, `AGENTS.md`, `region`, the stable OAuth `device_id`, provider credential JSON files, and the `agents`, `commands`, `skills`, and `themes` trees with their relative resource files. File contents are not printed. Existing destination files win as whole files; no field-level merging occurs. The source remains untouched. Sessions, daemon tokens, registries/locks, caches, and logs are excluded. Absolute references inside authored files are not rewritten: keep the source until you have checked those references and any session history you still need.

For each project, run `kiki migrate-config --workspace <directory> --json` to copy `local.toml`, `AGENTS.md`, `mcp.json`, and those authored trees from `.kimi-code` into `.kiki`. This option cannot be combined with `--from` or `--home`. Root `AGENTS.md` and standard `.mcp.json` stay untouched with their existing semantics and precedence. Product-local MCP still belongs to the chosen working directory; migrate a nested directory separately if it has its own legacy MCP config. Runtime discovery uses only the new product paths; an unmigrated legacy local config produces a migration instruction instead of being loaded silently.

After a filesystem failure, correct the reported issue and rerun the same command; previously copied files are preserved. Symbolic links are rejected rather than followed. Unknown source entries that have no destination counterpart produce `incomplete`, list their names, and return exit code `2` without a completion marker. Review and migrate those assets explicitly, then retry. Completion is recorded in `.kiki-config-migration-v2.json` only after the selected files are handled and no unknown entries remain; the earlier `.kiki-home-migration.json` marker does not prevent this asset-complete migration.

The desktop's compatibility home selects a read-only migration source, not a second runtime or OAuth home. Its model-category import does not copy credentials: use the full `migrate-config` operation or sign in again before relying on imported authentication references.
