# `kiki` Command

`kiki` is the product's unified CLI entry — the terminal form of the three-form product (desktop app, CLI/TUI, and server) — covering the daemon-backed interactive TUI, non-interactive `-p` mode, and shared-daemon controls. Running it without arguments attaches to an existing healthy daemon or starts one after workspace trust; `kiki -p` keeps the SDK-backed non-interactive path separate. Use `kiki serve` to control the daemon explicitly, and `kiki web` for the compatible foreground server/UI command. Its seat and MCP subcommands let external callers such as Cursor, Claude Code, and Codex call Kiki (inbound); they do not configure the external executors that Kiki uses to run subagents (outbound).

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

`--agent-file` registers a single agent file at the highest priority (for this launch only) and selects it; this flag cannot be repeated, and `--agent` and `--agent-file` are mutually exclusive. Both flags only apply when creating a new session — neither can be combined with `--session`/`--continue`, because the agent is bound at session creation and restored automatically when resuming. The selection is fixed once bound; in the TUI, these flags only bind the startup session, and new sessions created later within the same process (such as via `/new`) use the default agent. For agent file format and discovery directories, see [Agents and Subagents](../customization/agents.md#custom-agents).

## Non-Interactive Execution

Run a single prompt in scripts or CI with `-p`:

```sh
kiki -p "Summarize the current repository status"
```

Output follows the transcript format: thinking content and Assistant messages both start with `• `, indented by two spaces on line breaks. Assistant output goes to stdout; thinking, tool progress, and "resume session" hints go to stderr. The `-p` mode never prompts for human approval; regular tool calls follow the `auto` permission policy, and static deny rules remain in effect.

Switch models temporarily:

```sh
kiki -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

When you need to parse output programmatically, use the `stream-json` format — each line on stdout is a JSON object:

```sh
kiki -p "List changed files" --output-format stream-json
```

In `stream-json` mode, regular replies produce an Assistant message; when the model calls a tool, an Assistant message with `tool_calls` is emitted first, followed by the corresponding Tool message, then subsequent Assistant messages. Thinking content is not written to JSONL; tool progress and "resuming session" notices are still written to stderr.

## Subcommands

`kiki` provides the following subcommands: `serve` (start, reuse, or stop the shared daemon), `seat` (manage external-caller seats), `mcp` (run the stdio MCP edge), `doctor` (diagnose the daemon connection), `prompt-fields` (discover and validate prompt fields), `login` (non-interactive OAuth login), `acp` (ACP IDE mode), `web` (the compatible foreground REST/WebSocket/web service), `export` (export a session), and `provider` (manage providers).

### `kiki serve`

Control the shared daemon explicitly. With no mode, `serve` runs the daemon in the foreground; `--ensure` attaches to an existing healthy instance or starts one and returns its connection; `--stop` shuts down the reachable instance for the selected home.

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki resolves its home directory in this order: an explicit `--home` where supported, `KIKI_HOME`, then `~/.kiki`. Runtime startup uses only the Kiki home settings described here. The daemon uses one bearer token from `<home>/server.token`. `--idle-exit` defaults to `30m`; active client leases and running dispatches keep the daemon alive. Client leases are renewed through `POST /api/leases`. The interactive TUI performs the same attach-or-start behavior after workspace trust. Use [`kiki web`](#kiki-web) when a compatible foreground server and browser UI are required instead of shared-daemon control.

### `kiki seat`

Manage fixed external-caller seats used by Cursor, Claude Code, Codex, and other inbound MCP clients. A seat fixes the workspace, principal, permission mode, model, and thinking effort before an external caller connects:

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

The daemon creates or reuses one seat for each workspace and principal pair. The delegation token is returned only by `seat create`; `seat list` contains non-sensitive identity and configuration fields.

#### Install MCP Configuration

Install the stdio MCP configuration for a supported client:

```sh
kiki seat install --client cursor --workspace .
kiki seat install --client claude --workspace .
kiki seat install --client codex --workspace .
kiki seat install --client generic --workspace .
```

Cursor writes `~/.cursor/mcp.json`; Claude Code writes the workspace `.mcp.json`; Codex prints a `config.toml` snippet; `generic` prints JSON. An existing `kiki` entry is backed up before replacement.

### `kiki mcp`

Run the stdio MCP edge for an external caller. The command ensures the shared daemon is running, creates or reuses the workspace seat, and runs the MCP stdio edge:

```sh
kiki mcp --workspace <dir>
```

The external MCP caller cannot change the bound workspace, permission mode, model credentials, tool surface, or profile definitions.

### `kiki doctor`

Diagnose the local Kiki connection without starting the TUI or modifying files. It checks daemon reachability, token file paths and permissions, server identity, the external-caller seat list, and each seat's permission mode. Defaults to `KIKI_HOME` or `~/.kiki`; pass `--home` to inspect a different home. The report is printed as JSON by default (`--json` is kept as an explicit form with identical output) and never starts a server; run `kiki serve` or `kiki serve --ensure` first if a daemon is needed. To validate `config.toml`, `tui.toml`, and agent profiles instead, use `kiki doctor --agents` (or the subcommand form `kiki doctor agents`), which reports in human-readable text.

```sh
kiki doctor
kiki doctor --home /path/to/kiki --json
```

The report contains:

- `daemon`: whether a healthy daemon is reachable; includes URL and server ID when reachable
- `token`: token path, existence, file mode, and permission safety
- `seats`: non-sensitive seat ID, principal, workspace, and permission mode

### `kiki prompt-fields`

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

Client-provided stdio MCP servers are disabled by default. To trust an IDE to start local MCP processes under Kiki's account without separate Bash approvals, configure that IDE to run `kiki acp --allow-client-stdio-mcp`. See [MCP forwarding](../server/acp.md#mcp-forwarding) for details.

### `kiki web`

Run the local Kiki server in the foreground of the current terminal — a single process that exposes the REST + WebSocket API and serves the Kiki GUI from the same origin — and open the Kiki GUI in the default browser once it is ready. The command stays attached to the terminal and shuts down cleanly on `SIGINT` / `SIGTERM` (e.g. `Ctrl-C`).

When the server is running, `GET /openapi.json` returns the REST OpenAPI document and `GET /asyncapi.json` returns the local WebSocket AsyncAPI document. For an end-to-end walkthrough of driving sessions over the API, see [Local server and API](../server/local-server.md); for the protocol details, see the [Server API](../server/rest-api.md) reference.

```sh
kiki web                 # run the server in the foreground and open the browser
kiki web --no-open       # do not open the browser
kiki web --port 58628    # specify a custom port
```

Multiple instances can run concurrently under the same home: each registers itself in `~/.kiki/server/instances/`, and port collisions increment automatically (58628, 58629, etc.).

| Option | Description |
| --- | --- |
| `--port <port>` | Port to bind; default `58627`; increments automatically if occupied |
| `--host [host]` | Address to bind; default `127.0.0.1` (local only). Binding a non-loopback address (including bare `--host`, which targets `0.0.0.0`) requires either a TLS-terminating reverse proxy or `--insecure-no-tls`; without one of those the server refuses to start |
| `--insecure-no-tls` | Allow a non-loopback bind without a TLS-terminating reverse proxy; the bind is then reachable unencrypted on that address |
| `--allowed-host <host...>` | Additional Host header allowed by DNS rebinding checks, repeatable or comma-separated |
| `--log-level <level>` | Log level for the server; default off |
| `--debug-endpoints` | Mount `/api/debug/*` debug routes (default off) |
| `--dangerous-bypass-auth` | Disable bearer token auth for all REST and WebSocket routes, allowing Kiki GUI to connect without a token; use only in trusted networks or behind your own auth proxy |
| `--no-open` | Do not open the browser automatically once ready |

`kiki web` binds to the local loopback address by default and prints the bearer token in the startup banner; Kiki GUI authenticates automatically via the `#token=` URL fragment.

::: info Note
`kiki web` is a compatibility foreground command: it starts an independent server in the current process and does not connect to or manage the shared daemon. Use `kiki serve` to manage the shared daemon lifecycle; use `kiki web` when you need the existing foreground REST/WebSocket/web UI workflow. The legacy `kiki server …` command is no longer supported.
:::

::: danger Warning
`--dangerous-bypass-auth` completely disables authentication. Anyone with access to the port has full control over your sessions, filesystem, and shell. Use only in trusted networks or behind an authenticating reverse proxy, and stop the server with `Ctrl+C` when finished.
:::

#### `kiki web rotate-token`

Generate a new persistent bearer token (written to `~/.kiki/server.token`), invalidating the previous one immediately. The token is shared across the entire home directory, and running instances switch to the new token on their next auth check without requiring a restart.

### `kiki export`

Package a session into a ZIP archive for sharing, archiving, or bug reporting.

```sh
kiki export [sessionId] [options]
```

| Parameter / Option | Short | Description |
| --- | --- | --- |
| `sessionId` | | Session ID to export. When omitted, selects the most recent session in the current directory and asks for confirmation |
| `--output <path>` | `-o` | Output ZIP file path. Defaults to a filename in the current directory |
| `--yes` | `-y` | Skip confirmation when exporting the default session |
| `--no-include-global-log` | | Exclude the global diagnostic log. Included by default |

The export includes all files in the target session directory. The global diagnostic log (`~/.kiki/logs/kimi-code.log`) is included by default because it may contain events from other sessions or projects; add `--no-include-global-log` if you do not want to share it.

```sh
# Export the most recent session in the current directory, skipping confirmation
kiki export -y

# Export a specific session to a custom path
kiki export 01HZ...XYZ -o ./bug-report.zip

# Exclude global diagnostic logs
kiki export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kiki provider`

Manage providers from the shell — the non-interactive counterpart to `/provider` in the TUI. Useful for scripted deployments, CI setup, and configuring new machines in a single command.

```sh
kiki provider <action> [options]
```

Supports five actions:

#### `kiki provider add <url>`

Import all providers in bulk from a custom registry (`api.json`). This explicit command fetches the registry, creates `[providers.<id>]` and `[models.<alias>]` for each entry, and records the registry in `source` metadata. Later startup does not synchronize the registry. Manual model fetching returns unsaved suggestions for existing providers; see [Fetching model suggestions](../configuration/providers.md#fetching-model-suggestions).

| Parameter / Option | Description |
| --- | --- |
| `<url>` | Registry URL |
| `--api-key <key>` | Bearer token for accessing the registry. Required: falls back to `KIKI_REGISTRY_API_KEY` when omitted, and the command exits with an error when neither is provided |

```sh
kiki provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Or via environment variable (suitable for CI / .envrc)
KIKI_REGISTRY_API_KEY=YOUR_KEY kiki provider add https://registry.example.com/v1/models/api.json
```

If a provider id already exists, it is removed before re-writing. A default model is not set automatically; choose one later with `-m` or `/model` in the TUI.

#### `kiki provider remove <providerId>`

Remove a provider and all its model aliases. If the removed provider owns `default_model`, that setting is cleared as well.

```sh
kiki provider remove kohub
```

#### `kiki provider list`

Print each configured provider on its own line, including its type, model count, and source. Add `--json` to output the raw `providers` and `models` tables for scripting.

```sh
kiki provider list
kiki provider list --json | jq '.providers | keys'
```

#### `kiki provider catalog list [providerId]`

Browse the public [models.dev](https://models.dev/) catalog without modifying configuration. With no arguments, lists all providers, their protocol types, and model counts; with `providerId`, lists context windows and capabilities for that provider's models. Uses a built-in snapshot when the catalog URL is unreachable.

| Parameter / Option | Description |
| --- | --- |
| `[providerId]` | Optional provider id to inspect |
| `--filter <substring>` | Case-insensitive substring filter on id or name |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |
| `--json` | Output matching entries as JSON |

```sh
kiki provider catalog list
kiki provider catalog list --filter anthropic
kiki provider catalog list anthropic
```

#### `kiki provider catalog add <providerId>`

Import a known provider directly from the catalog by id; protocol type, base URL, and model metadata come from the catalog, so you only need to supply the API key. Providers without a declared protocol (such as xai or openrouter with vendor-specific SDKs) are imported using OpenAI-compatible protocol with a "guessed" annotation in the output; specify `--base-url` explicitly when the catalog provides no usable endpoint. Proprietary protocols (such as Amazon Bedrock) cannot be imported. Falls back to a built-in catalog snapshot when offline or in restricted network environments.

| Parameter / Option | Description |
| --- | --- |
| `<providerId>` | Provider id in the catalog, e.g. `anthropic`, `openai` |
| `--api-key <key>` | Provider API key. Required: falls back to `KIKI_REGISTRY_API_KEY` when omitted, and the command exits with an error when neither is provided |
| `--default-model <modelId>` | Optional; sets `default_model` to `<providerId>/<modelId>` after import |
| `--base-url <url>` | Override the catalog endpoint; required when the catalog omits the endpoint or leaves env-var placeholders |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |

```sh
kiki provider catalog list anthropic          # inspect available models first
kiki provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Next Steps

- [Slash commands](./slash-commands.md) — Interactive TUI command quick reference
- [Keyboard shortcuts](../reference/keyboard.md) — Terminal and interface keyboard shortcuts
- [Built-in tools](../reference/tools.md) — Tool catalog and permission reference
- [Configuration files](../configuration/config-files.md) — Persistent configuration for `default_model`, permission modes, and startup options
- [Using in IDEs](../server/ide.md) — Editor and IDE integration
- [Agent Skills](../customization/skills.md) — Format of Skill files loaded by `--skills-dir`
- [Agents and Subagents](../customization/agents.md) — Built-in subagents, custom agent files, and selecting the main agent with `--agent`
