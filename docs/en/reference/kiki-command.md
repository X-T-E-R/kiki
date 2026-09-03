# `kiki` command

The `kiki` command manages the shared local daemon used by external callers such as Cursor, Claude Code, and Codex to call Kiki (inbound). It does not configure the external executors or harnesses that Kiki uses to run subagents (outbound).

## Start or reuse the daemon

Start the daemon in the foreground, or attach to an existing healthy instance and start one when needed:

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki resolves its home directory in this order: `--home`, `KIKI_HOME`, the compatible `KIMI_CODE_HOME` setting, then `~/.kiki`. The daemon uses one bearer token from `<home>/server.token`. `--idle-exit` defaults to `30m`; active client leases and running dispatches keep the daemon alive. Client leases are renewed through `POST /api/v1/leases`.

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

## Migration from `kimi`

The existing `kimi` command remains the interactive CLI and TUI entry point. Use [`kimi`](./kimi-command.md) for interactive sessions and use `kiki` for daemon, seat, and external-caller integration workflows.
