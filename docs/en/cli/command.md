# `kiki` Command

`kiki` is the product's unified CLI entry — the terminal form of the three-form product (desktop app, CLI/TUI, and server) — covering the daemon-backed interactive TUI, non-interactive `-p` mode, and shared-daemon controls. Running it without arguments attaches to an existing healthy daemon or starts one after workspace trust; `kiki -p` keeps the SDK-backed non-interactive path separate. Use `kiki serve` to control the daemon explicitly, and `kiki web` for the compatible foreground server/UI command.

```sh
kiki [options]
kiki <subcommand> [options]
```

Interactive sessions always use the shared background daemon. After workspace trust is confirmed, the CLI attaches to an existing daemon or starts one automatically; no separate installation or experimental flag is required. If connection or startup fails, the error is shown instead of falling back to an independent local session. Correct the reported error and run the command again. Non-interactive `--prompt` execution is separate from this terminal startup path.

## Main Command Options

All flags are optional — run `kiki` directly to enter an interactive session:

| Option | Short | Description |
| --- | --- | --- |
| `--version` | `-V` | Print the version number and exit |
| `--help` | `-h` | Show help information and exit |
| `--session [id]` | `-S` | Resume a session. With an ID, opens that session directly; without an ID, enters an interactive selector |
| `--continue` | `-c` | Continue the most recent session in the current working directory, without specifying an ID manually |
| `--model <model>` | `-m` | Specify a model alias for this launch. When omitted, new sessions use `default_model` from the config file |
| `--prompt <prompt>` | `-p` | Run a single prompt non-interactively and stream the Assistant output to stdout. This mode does not open the TUI |
| `--output-format <format>` | | Set the non-interactive output format; supports `text` and `stream-json`. Can only be used with `--prompt`; defaults to `text` |
| `--yolo` | `-y` | Auto-approve regular tool calls, skipping approval requests |
| `--auto` | | Start with auto permission mode; tool approvals are handled automatically and the Agent will not ask the user questions |
| `--plan` | | Start a new session in Plan mode — the AI will prioritize read-only tools for exploration and planning |
| `--skills-dir <dir>` | | Load Skills from the specified directory, replacing the automatically discovered user and project directories. Can be repeated |
| `--agent <name>` | | Start a new session with the specified agent as the main Agent. Cannot be combined with `--session`/`--continue` |
| `--agent-file <path>` | | Load a custom agent from a Markdown file for the new session and select it. Cannot be repeated or combined with `--agent`, `--session`, or `--continue` |
| `--add-dir <dir>` | | Add an extra workspace directory for this session. Relative paths resolve against the current working directory. Can be repeated |

`-r` / `--resume` is a hidden alias for `--session`; `--yes` and `--auto-approve` are hidden aliases for `--yolo` and are not shown in help output.

::: warning
`--yolo` skips human approval for regular tool calls, including file writes and shell command execution. Use it only in trusted working directories. Plan mode exit approval is not bypassed by `--yolo`; `Bash` inside Plan mode is handled under the regular allow rules.
:::

### Flag Conflict Rules

The following combinations are rejected at startup:

- `--continue` and `--session` are mutually exclusive — both mean "resume a previous session"
- `--yolo` and `--auto` are mutually exclusive — the two permission modes cannot be combined
- `--prompt` cannot be used with `--yolo`, `--auto`, or `--plan` — non-interactive mode uses `auto` permission by default
- `--output-format` can only be used together with `--prompt`

When resuming a session, you can override its saved permission or plan mode by adding `--auto`, `--yolo`, or `--plan`. For example, `kiki --continue --auto` resumes the latest session and switches it to auto permission mode.

## Common Usage

Start a new session directly:

```sh
kiki
```

Pick up where you left off (automatically finds the most recent session in the current directory):

```sh
kiki --continue
```

Choose from the session history list, or specify a known ID directly:

```sh
kiki --session
kiki --session 01HZ...XYZ
```

Skip approval prompts — suitable for batch tasks that are known to be safe:

```sh
kiki --yolo
```

Let the Agent handle everything autonomously, without asking the user questions:

```sh
kiki --auto
```

Read the code and produce an implementation plan before making any file changes:

```sh
kiki --plan
```

### Custom Skills Directories

There are two ways to specify Skills directories, with different semantics:

- **`--skills-dir <dir>`** (CLI flag): **Replaces** the automatically discovered user and project directories for this launch only. Can be repeated to stack multiple directories:

  ```sh
  kiki --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs`** (`config.toml`): **Adds** directories on top of the automatically discovered ones, taking effect permanently. Suitable for configuring team-shared Skills. See [Agent Skills](../customization/skills.md).

### Custom Agents

`--agent` and `--agent-file` select which agent drives a new session, in both print mode (`kiki -p`) and the interactive TUI:

```sh
kiki --agent reviewer
kiki -p --agent reviewer "Review the changes on this branch"
```

`--agent-file` registers a single agent file at the highest priority for this launch only and selects it; the flag cannot be repeated, and `--agent` and `--agent-file` are mutually exclusive. Both flags only apply when starting a new session — neither can be combined with `--session`/`--continue`, because the agent is bound at session creation and resuming restores the bound agent automatically. The selection is fixed at the session's first bind and cannot be switched later; in the TUI the flags bind only the startup session, and a session created later in the same process (for example via `/new`) starts with the default agent. See [Agents and Sub-Agents](../customization/agents.md#custom-agents) for the agent file format and discovery directories.

## Non-Interactive Execution

When running a single prompt in a script or CI environment, use `-p`:

```sh
kiki -p "Summarize the current repository status"
```

Output uses a transcript style: thinking content and Assistant text are both prefixed with `• `, and wrapped lines are indented by two spaces. Assistant text goes to stdout; thinking, tool progress, and "resuming session" notices go to stderr. In `-p` mode, no human approval is requested — regular tool calls are handled under the `auto` permission policy, while static deny rules remain in effect.

Temporarily switch the model:

```sh
kiki -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

When you need to parse output programmatically, use the `stream-json` format — each line on stdout is a JSON object:

```sh
kiki -p "List changed files" --output-format stream-json
```

In `stream-json` mode, regular replies produce an Assistant message; when the model calls a tool, an Assistant message with `tool_calls` is emitted first, followed by the corresponding Tool message, then subsequent Assistant messages. Thinking content is not written to JSONL; tool progress and "resuming session" notices are still written to stderr.

## Subcommands

`kiki` provides the following subcommands: `serve` (start, reuse, or stop the shared daemon), `seat` (manage external-caller seats), `mcp` (run the stdio MCP edge), `doctor` (diagnose the daemon connection), `migrate-config` (explicitly migrate legacy configuration and authored assets), `login` (non-interactive OAuth login), `acp` (ACP IDE mode), `web` (the compatible foreground REST/WebSocket/web service), `export` (export a session), and `provider` (manage providers).

### `kiki serve`

Control the shared daemon explicitly. With no mode, `serve` runs the daemon in the foreground; `--ensure` attaches to an existing healthy instance or starts one and returns its connection; `--stop` shuts down the reachable instance for the selected home.

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

The interactive TUI performs the same attach-or-start behavior after workspace trust. `--idle-exit` defaults to `30m`; active client leases and running dispatches keep the daemon alive. Use [`kiki web`](#kiki-web) when a compatible foreground server and browser UI are required instead of shared-daemon control.

### `kiki seat`

Create, list, or revoke the fixed external-caller seats used by Cursor, Claude Code, Codex, and other inbound MCP clients. A seat binds the workspace, principal, permission mode, model, and thinking effort before the caller connects.

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

### `kiki mcp`

Run the stdio MCP edge for an external caller. The command ensures the shared daemon is running, creates or reuses the workspace seat, and keeps the workspace and seat policy fixed for that caller.

```sh
kiki mcp --workspace <directory>
```

### `kiki migrate-config`

Copy legacy configuration and authored assets into `KIKI_HOME` (default `~/.kiki`) without overwriting existing Kiki files. This is the only command that reads the legacy `KIMI_CODE_HOME` environment variable; otherwise the default source is `~/.kimi-code`. It does not migrate sessions, daemon tokens, caches, registries, locks, or logs. For a project, use `--workspace` to copy its legacy `.kimi-code` assets into `.kiki`.

```sh
kiki migrate-config --json
kiki migrate-config --workspace <directory> --json
```

### `kiki login`

Log in to Kimi Code OAuth via the RFC 8628 device-code flow, without entering the TUI. The command issues a device authorization request, prints the verification URL and user code to stderr, then polls until the browser-side authorization is complete. The generated token is written to the same local location as TUI `/login` and is loaded automatically the next time `kiki` starts.

```sh
kiki login
```

This subcommand has no flags. Press `Ctrl-C` at any time during polling to cancel; the exit code is `1` on cancellation or failure, and `0` on success.

### `kiki acp`

Switch Kiki to ACP (Agent Client Protocol) mode, communicating with an IDE via JSON-RPC over stdin/stdout so the editor can directly drive Kiki's sessions and tool calls. You typically do not need to run this manually — the IDE starts it as a subprocess entry point. For configuration, see [Using in IDEs](../server/ide.md); for technical details, see the [kiki acp reference](../server/acp.md).

```sh
kiki acp
```

### `kiki web`

Run the local Kiki server in the foreground of the current terminal — a single process that exposes the REST + WebSocket API and serves the Kiki GUI from the same origin — and open the Kiki GUI in the default browser once it is ready. The command stays attached to the terminal and shuts down cleanly on `SIGINT` / `SIGTERM` (e.g. `Ctrl-C`).

When the server is running, `GET /openapi.json` returns the REST OpenAPI document and `GET /asyncapi.json` returns the local WebSocket AsyncAPI document. For an end-to-end walkthrough of driving sessions over the API, see [Local server and API](../server/local-server.md); for the protocol details, see the [Server API](../server/rest-api.md) reference.

```sh
kiki web                 # run the server in the foreground and open the browser
kiki web --no-open       # don't open the browser
kiki web --port 58628    # pick a specific bind port
```

Multiple instances can share one home directory: each registers itself under `~/.kiki/server/instances/`, and a busy port is retried with `port + 1` (58628, 58629, …).

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port; defaults to `58627`; a busy port is retried with `+1` |
| `--host [host]` | Bind host; omit for `127.0.0.1` (this machine only), pass a bare `--host` for `0.0.0.0` (all interfaces) |
| `--allowed-host <host...>` | Extra Host header values allowed through the DNS-rebinding check; repeatable or comma-separated |
| `--log-level <level>` | Enable server logs at the selected level; omitted by default |
| `--debug-endpoints` | Mount `/api/debug/*` routes (off by default) |
| `--dangerous-bypass-auth` | Disable bearer-token auth on all REST and WebSocket routes so the Kiki GUI connects without a token; only for trusted networks or behind an authenticating proxy |
| `--no-open` | Do not open the browser once the server is ready |

`kiki web` binds to local loopback only by default and prints the bearer token in the startup banner; the Kiki GUI authenticates automatically via the `#token=` URL fragment.

::: info
`kiki web` is the compatibility foreground command. It starts a dedicated server in the current process and does not attach to or manage the shared daemon; use `kiki serve` for shared-daemon lifecycle and `kiki web` when an existing foreground REST/WebSocket/web UI flow requires it. Legacy `kiki server …` commands are no longer supported.
:::

::: danger
`--dangerous-bypass-auth` disables authentication entirely. Anyone who can reach the port gets full access to your sessions, filesystem, and shell. Only use it on a trusted network or behind your own authenticating reverse proxy, and stop the server with `Ctrl+C` when you are done.
:::

#### `kiki web rotate-token`

Generate a new persistent bearer token (written to `~/.kiki/server.token`); the previous token stops working immediately. The token is shared by the whole home directory, so every running instance picks the new one up on its next auth check — no restart needed.

### `kiki doctor`

Diagnose the local Kiki connection without starting the TUI or changing files. It checks daemon reachability, the selected home token path and permissions, the server identity, and the external-caller seat list. By default it uses `KIKI_HOME` or `~/.kiki`; use `--home` to inspect another home. The report is JSON and does not start a server, so run `kiki serve` or `kiki serve --ensure` first when you want to create one.

```sh
kiki doctor
kiki doctor --home /path/to/kiki --json
```

The report includes:

- `daemon`: whether a healthy daemon is reachable, with its URL and server ID when available
- `token`: the token path, existence, file mode, and whether its permissions are secure
- `seats`: non-sensitive seat IDs, principals, workspaces, and permission modes

### `kiki export`

Package a session into a ZIP file for sharing, archiving, or submitting bug reports.

```sh
kiki export [sessionId] [options]
```

| Parameter / Option | Short | Description |
| --- | --- | --- |
| `sessionId` | | The ID of the session to export. When omitted, the most recent session in the current working directory is automatically selected and requires confirmation |
| `--output <path>` | `-o` | Output ZIP file path. When omitted, writes to a default filename in the current directory |
| `--yes` | `-y` | Skip the confirmation prompt for the default session and export directly |
| `--no-include-global-log` | | Do not include the global diagnostic log. Included by default |

The export contains all files in the target session directory. The global diagnostic log (`~/.kiki/logs/kimi-code.log`) is included by default because it may contain events from other sessions or projects; add `--no-include-global-log` if you do not want to share it.

```sh
# Export the most recent session in the current directory, skipping confirmation
kiki export -y

# Export a specific session to a custom path
kiki export 01HZ...XYZ -o ./bug-report.zip

# Exclude the global diagnostic log
kiki export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kiki provider`

Manage providers in the shell — the non-interactive equivalent of `/provider` in the TUI. Suitable for scripted deployments, CI initialization, and one-line setup on a new machine.

```sh
kiki provider <action> [options]
```

Five actions are available:

#### `kiki provider add <url>`

Bulk-import all providers from a custom registry (`api.json`). The command fetches the registry, creates a `[providers.<id>]` and `[models.<alias>]` entry for each item, and writes `source` metadata so the TUI refreshes providers and models from the same registry URL automatically on next startup.

| Parameter / Option | Description |
| --- | --- |
| `<url>` | Registry URL |
| `--api-key <key>` | Bearer token for accessing the registry. Falls back to the `KIKI_REGISTRY_API_KEY` environment variable if not provided; required |

```sh
kiki provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Or via environment variable (suitable for CI / .envrc)
KIKI_REGISTRY_API_KEY=YOUR_KEY kiki provider add https://registry.example.com/v1/models/api.json
```

If a provider ID already exists, it is removed and re-created. The default model is not set automatically; you can select one later with `-m` or `/model` in the TUI.

#### `kiki provider remove <providerId>`

Remove the specified provider and all its model aliases. If the removed provider is the one referenced by `default_model`, `default_model` is also cleared.

```sh
kiki provider remove kohub
```

#### `kiki provider list`

Print each configured provider on a separate line, including type, model count, and source. Add `--json` to output the raw `providers` and `models` tables for programmatic processing.

```sh
kiki provider list
kiki provider list --json | jq '.providers | keys'
```

#### `kiki provider catalog list [providerId]`

Browse the public [models.dev](https://models.dev/) model catalog without modifying any configuration. Without an argument, lists all providers along with their protocol type and model count; with a `providerId`, lists all models under that provider along with their context window and capabilities. If the catalog URL cannot be reached, a built-in snapshot of the catalog is used instead.

| Parameter / Option | Description |
| --- | --- |
| `[providerId]` | Optional — the provider ID to inspect |
| `--filter <substring>` | Case-insensitive substring filter on ID or name |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |
| `--json` | Output matching entries as JSON |

```sh
kiki provider catalog list
kiki provider catalog list --filter anthropic
kiki provider catalog list anthropic
```

#### `kiki provider catalog add <providerId>`

Import a known provider directly from the catalog by ID. The protocol type, base URL, and model information are all supplied by the catalog — only an API key is required. Vendors whose protocol the catalog does not declare (e.g. xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible and the output notes the guess; when the catalog provides no usable endpoint, `--base-url` is required. Proprietary protocols (e.g. Amazon Bedrock) cannot be imported. When the public catalog is unreachable, the import uses the built-in snapshot, so it still works offline or in blocked networks.

| Parameter / Option | Description |
| --- | --- |
| `<providerId>` | Provider ID in the catalog, e.g., `anthropic`, `openai` |
| `--api-key <key>` | Provider API key. Falls back to `KIKI_REGISTRY_API_KEY` if not provided; required |
| `--default-model <modelId>` | Optional — set `default_model` to `<providerId>/<modelId>` after import |
| `--base-url <url>` | Override the catalog endpoint; required when the catalog declares none (or only an env placeholder) |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |

```sh
kiki provider catalog list anthropic          # Browse available models first
kiki provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Kiki daemon integration

For shared-daemon, external-caller seat, and MCP setup workflows, use [the `kiki` command](../server/daemon.md).
## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for control commands in the interactive TUI
- [Configuration Files](../configuration/config-files.md) — Persistent configuration for `default_model`, permission mode, and other startup parameters
- [Agent Skills](../customization/skills.md) — Skill file format for directories loaded via `--skills-dir`
- [Agents and Sub-Agents](../customization/agents.md) — Built-in sub-agents, custom agent files, and main Agent selection via `--agent`
