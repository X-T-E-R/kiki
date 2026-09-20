# Migrating from kimi-cli

::: info
This page only applies if you are migrating from a historical Python/uv `kimi-cli` installation (or an older Kimi Code installation). New Kiki users can skip this page entirely and go straight to [First launch](./first-launch.md).
:::

If you still have a legacy `kimi-cli` home (the directory that stores configuration and session data — `~/.kimi-code/` or `~/.kimi/` on older setups) or an older Kimi Code home, migrate it explicitly with `kiki migrate-config`. The source is read only for that operation; normal `kiki` startup uses only `KIKI_HOME` or `~/.kiki`.

Migration takes three steps:

1. Back up the old home directory, just in case.
2. Run `kiki migrate-config` (details below).
3. Start `kiki` and confirm your session history and configuration are in place.

## Current migration contract

- The installed executable is `kiki`; the old `kimi` bin is not installed.
- Running `kiki` without a subcommand starts the TUI. Use `kiki -p "prompt"` for the non-interactive single-prompt mode.
- Legacy home and project paths are migration sources only. Runtime discovery does not fall back to them.
- The desktop compatibility home is also a read-only migration source, not a second runtime or a source of OAuth (passwordless third-party authorization) sign-in data.

## Migrate a home

Run the explicit home migration command:

```sh
kiki migrate-config --json
```

By default, the command copies from `~/.kimi-code` into `KIKI_HOME` or `~/.kiki`. To select a different source or destination, pass them explicitly:

```sh
kiki migrate-config --from /path/to/legacy-home --home /path/to/kiki-home --json
```

If your historical `kimi-cli` data is still under `~/.kimi/`, pass `--from ~/.kimi`; it is not guessed during normal startup. `KIMI_CODE_HOME` is accepted only as the source for this explicit migration command.

For a project, copy the legacy `.kimi-code` local configuration and authored trees into `.kiki`:

```sh
kiki migrate-config --workspace /path/to/project --json
```

The `--workspace` form cannot be combined with `--from` or `--home`.

## What gets copied

The home migration can copy `config.toml`, `mcp.json`, `tui.toml`, `SYSTEM.md`, `region`, the stable OAuth `device_id` (the device identifier generated on this machine at OAuth sign-in, used to keep you logged in), provider credential JSON files (the files that record your API keys), and the `agents`, `commands`, `skills`, and `themes` trees with their relative resource files. Existing destination files win as whole files; no field-level merge occurs. File contents are not printed.

The project migration copies the legacy `.kimi-code/local.toml` and the authored project trees into `.kiki`. Runtime discovery uses only the new `.kiki` paths after migration.

## What stays behind

Sessions, daemon tokens, registries and locks, caches, and logs are excluded. Absolute references inside authored files are not rewritten, so keep the source until you have checked those references and any session history you still need. A desktop model-category import does not copy credentials; use the full `migrate-config` operation or sign in again before relying on imported authentication references.

::: tip
Migration never modifies or deletes the source. Existing destination files are preserved, and you can rerun the same command after correcting a filesystem error. Symbolic links are rejected rather than followed. If unrecognized source entries remain, the command reports `incomplete`, lists them, and exits with code `2` (the exit code is the status number a program returns when it finishes; non-zero means it did not fully succeed); review those assets and retry before treating the migration as complete.
:::
