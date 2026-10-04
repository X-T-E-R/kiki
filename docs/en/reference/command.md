# `kiki` Command

`kiki` is the product's unified CLI entry — the terminal form of the three-form product (desktop app, CLI/TUI, and server) — covering the daemon-backed interactive TUI, non-interactive `-p` mode, and shared-daemon controls. Running it without arguments attaches to an existing healthy daemon or starts one after workspace trust; `kiki -p` keeps the SDK-backed non-interactive path separate. Use `kiki serve` to control the daemon explicitly, and `kiki web` for the compatible foreground server/UI command. Its seat and MCP subcommands let external callers such as Cursor, Claude Code, and Codex call Kiki (inbound); they do not configure the external executors that Kiki uses to run subagents (outbound).

```sh
kiki [options]
kiki <subcommand> [options]
```

Interactive sessions always use the shared background daemon. After workspace trust is confirmed, the CLI attaches to an existing daemon or starts one automatically; no separate installation or experimental flag is required. If connection or startup fails, the error is shown instead of falling back to an independent local session. Correct the reported error and run the command again. Non-interactive `--prompt` execution is separate from this terminal startup path.

Interactive mode needs a terminal on both stdin and stdout. A pipe or a redirect on either one ends the run before workspace trust and the daemon are involved — Kiki does not switch to non-interactive mode for you. To supply a prompt from a pipe, run `kiki -p -` and let Kiki read the prompt from stdin.

## Main Command Options

All flags are optional — run `kiki` directly to enter an interactive session:

| Option | Short | Description |
| --- | --- | --- |
| `--version` | `-V` | Print the version number and exit |
| `--help` | `-h` | Show help information and exit |
| `--session [id]` | `-S` | Resume a session. With an ID, opens that session directly; without an ID, enters an interactive selector |
| `--continue` | `-c` | Continue the most recent session in the current working directory, without specifying an ID manually |
| `--model <model>` | `-m` | Specify a model alias for this launch. When omitted, new sessions use `default_model` from the config file |
| `--prompt <prompt>` | `-p` | Run a single prompt non-interactively and stream the Assistant output to stdout; pass `-` to read from stdin (the program's input stream) |
| `--prompt-file <path>` | | Run one prompt read from a UTF-8 file; cannot be combined with `--prompt` |
| `--output-format <format>` | | Set the non-interactive output format; supports `text` and `stream-json`. Can only be used with a prompt; defaults to `text` |
| `--wait-for-session <seconds>` | | Wait for a session lock in non-interactive mode before failing |
| `--timeout <seconds>` | | Limit the entire non-interactive run, including prompt input, startup, session locks, model calls and goal/background waits. Accepts positive seconds (at least `0.001`); no deadline by default. Expiry cancels the active agent and fails the run; bounded cleanup may take additional time |
| `--include-thinking` | | Include thinking deltas in `stream-json` output; off by default |
| `--yolo` | `-y` | Auto-approve regular tool calls, skipping approval requests |
| `--auto` | | Start in Auto permission mode; routine tool calls proceed automatically, while protected calls and agent questions may still prompt you |
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
- `--prompt` and `--prompt-file` cannot be combined; neither works with `--yolo`, `--auto`, or `--plan`. Prompt runs preserve the session's permission mode unless `--permission-mode` is supplied; a fresh session defaults to `auto` unless configured otherwise. An override on a resumed session is restored on exit.
- `--output-format` requires `--prompt` or `--prompt-file`

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

Auto-approve routine calls while retaining prompts for protected actions:

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

For a multiline prompt, pass a UTF-8 file with `--prompt-file <path>` or pipe its contents into `kiki -p -`. In Windows scripts, launch the installed `kiki.exe` directly when passing a multiline command-line argument: the auto-generated `kiki.cmd` forwarder uses `%*`, which truncates arguments at a newline. `--prompt-file` and `-p -` avoid the command-line newline entirely.

When you need to parse output programmatically, use the `stream-json` format — each line on stdout is a JSON object:

```sh
kiki -p "List changed files" --output-format stream-json
```

In `stream-json` mode, regular replies produce an Assistant message; when the model calls a tool, an Assistant message with `tool_calls` is emitted first, followed by the corresponding Tool message, then subsequent Assistant messages. Thinking content is omitted by default; add `--include-thinking` to emit each thinking delta as `{"role":"assistant","type":"thinking.delta","content":"..."}` on stdout. Tool progress and "resuming session" notices are still written to stderr.

### Concurrent print runs with one KIKI_HOME

Multiple `kiki -p` processes may share one `KIKI_HOME` when each process uses a different session. Kiki serializes the shared runtime-owner record and session index writes, while each session still has one active writer. Do not run two prompts against the same session at the same time; use `--wait-for-session <seconds>` when a previous process is expected to release that session shortly.

Thread communication is disabled by default. A print run that does not use thread tools does not initialize the mailbox. When thread communication is enabled, set `KIKI_THREAD_MAILBOX_TIMEOUT_MS` to change its bounded mailbox call timeout. Print mode ticks scheduled tasks for the sessions it already has open. It does not scan the rest of the home or wake closed sessions, so tasks scheduled outside this run still need the interactive daemon or server. For maximum isolation or when a workload needs independent caches and configuration, use a separate `KIKI_HOME` per worker.

## Subcommands

`kiki` provides the following subcommands: `serve` (start, reuse, or stop the shared daemon), `seat` (manage external-caller seats), `mcp` (run the stdio MCP edge), `doctor` (diagnose the daemon connection), `prompt-fields` (discover and validate prompt fields), `login` (non-interactive OAuth login), `acp` (ACP IDE mode), `web` (the compatible foreground REST/WebSocket/web service), `export` (export a session), and `provider` (manage providers).

### `kiki serve`

Control the shared daemon explicitly. With no mode, `serve` runs the daemon in the foreground; `--query --json` reports the current instance without starting one; `--ensure` attaches to an existing healthy instance or starts one and returns its connection; `--stop` shuts down the reachable instance for the selected home. If a live instance is found but its identity cannot be verified, Kiki refuses to start a second instance: stop or upgrade the existing one before retrying.

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki resolves its home directory in this order: an explicit `--home` where supported, `KIKI_HOME`, then `~/.kiki`. Trusted local clients attach with the private `<home>/server.local-owner` capability; remote connections use separate credentials described under [Authentication](../server/local-server.md#authentication). `--idle-exit` defaults to `30m`; active client leases and running dispatches keep the daemon alive. Set `--idle-exit 0ms` to keep a newly started daemon running until explicitly stopped. Client leases are renewed through `POST /api/leases`. The interactive TUI performs the same attach-or-start behavior after workspace trust. Use [`kiki web`](#kiki-web) for a compatible foreground server and browser UI.

### `kiki connections`

Manage directed GUI connections between homes. `--home` selects the local source or provider home; management uses its local-owner credential. Receiving is off by default, and enabling the gate does not approve any source by itself.

```sh
kiki connections --home /path/to/source status
kiki connections --home /path/to/target inbound enable
kiki connections --home /path/to/target inbound invite --input source.json
kiki connections --home /path/to/source add --input connection.json
```

Use the source `identity` from `status` in `source.json`: `{ "source": { "homeId": "...", "hostId": "...", "protocol": 1 }, "label": "Source home" }`. The target returns a short-lived, one-use `invitation`. `connection.json` contains `label`, `endpoint`, the target `identity` as `target`, its current `ownerToken`, and that `invitation`; `backgroundSummary` optionally enables lightweight status polling. `homeId` is a UUID identifying the home, not a GUI space ID. Keep secret-bearing files private, delete them after successful setup, and never put tokens in command arguments. `--input -` reads JSON from stdin (the input channel of the command).

Use `inbound revoke <grantId>` on the target to stop one source's reads and streams without affecting other approved sources. `inbound disable` closes all peer access while retaining the allow list. On the source, `disable <connectionId>`, `enable <connectionId>`, `retry <connectionId>`, and `remove <connectionId>` manage that connection. Removal releases local credentials and owned tunnels; it does not stop the target daemon or undo work already started there. Offline status retains last-known measurements and their timestamp, rather than reporting invented zero counts.

For SSH, both hosts need a compatible Kiki installation, and the source needs working SSH authentication and known-host verification. Kiki does not install remote software. Save a non-secret profile such as:

```json
{
  "id": "work-host", "label": "Work home",
  "target": { "kind": "alias", "alias": "work-host" },
  "releaseChannel": "stable", "remoteHome": "/home/example/.kiki",
  "remoteExecutable": "kiki", "remoteShell": "posix"
}
```

The target may instead be `{ "kind": "host", "hostname": "example.com", "username": "example", "port": 22 }`; `identityFile` is optional. Plan first, then review the returned target, identity and effects:

```sh
kiki connections --home /path/to/source ssh plan --input profile.json
kiki connections --home /path/to/source ssh execute PLAN_ID
kiki connections --home /path/to/source ssh execute PLAN_ID --ensure
kiki connections --home /path/to/source ssh register --input registration.json
kiki connections --home /path/to/source ssh status
```

Planning only queries; execution without `--ensure` only attaches. Explicit `--ensure` may start a remote daemon that continues in the background until explicitly stopped. It does not open inbound access. For GUI registration, `registration.json` is `{ "purpose": "gui", "planId": "PLAN_ID", "label": "Work home", "enableInbound": false, "backgroundSummary": true }`. With `enableInbound: false`, a closed target gate is reported as closed; choose `true` only when you explicitly want this setup to open it. Backend-only bootstrap credentials are discarded after provisioning. `purpose: "bridge"` registers a bridge-only target and requires separate bridge policy approval; it does not also grant GUI access.

### `kiki bridges`

Manage explicit one-way thread bridges without granting GUI browsing access. `--home` selects the executing source or provider home; management always uses its local-owner credential. Receiving is off by default. First start the target daemon and explicitly enable inbound access with `kiki connections --home <target-home> inbound enable`; this does not authorize a model turn.

```sh
kiki bridges --home /path/to/source status
kiki bridges --home /path/to/source local --input ./local-bridge.json
kiki bridges --home /path/to/source receipts --limit 50
kiki bridges --home /path/to/source outbound disable <bridgeId>
kiki bridges --home /path/to/provider inbound revoke <bridgeId>
```

`local` reads JSON with `spaceId` (an already registered local space), `sourceScope`, `targetScope`, `operations`, `expiresAt` (Unix milliseconds), `label`, and optional `pendingLimit` and `messagesPerMinute`. Each scope names a `workspaceId` and normally a `sessionId`; omitting the session explicitly approves future threads in that workspace. Choose `read`, `send`, and `wait` separately; add `wake` only when the target may receive a model prompt or resume a cold thread. Without wake, sends remain pending. Local targets use a stable space reference, so a daemon restart may change its port without changing the approved home.

For a network target, use `target --input <file>` with `{label,endpoint,target}`, where target is `{homeId,hostId,protocol:1}`. On the provider, `approve --input <file>` takes a policy with those source and target identities, scopes, operations, expiry, label, and `location: "network"`; its one-time result contains `{grant,credential}`. On the source, `install --input <file>` takes that result plus the registered `connectionId`. Use HTTPS or a trusted tunnel. A reverse bridge needs another approval. GUI tokens and SSH login do not grant bridge access.

Protect the approve output and install input as credentials. Every `--input` also accepts `-` to read JSON from stdin (the program's input stream); do not put a credential in command-line arguments or send it to the model. `status` and paged `receipts` omit credentials. Receipts distinguish source pending, target accepted, prompt delivered, and rejection; delivered does not mean the model has replied. Pending sends keep their original key and sequence while retrying for at most 15 minutes. `retry` checks the durable queue; it does not create a new message. `inbound|outbound enable|disable|revoke <bridgeId>` controls one link; inbound revision changes require explicitly reinstalling the newer grant at the source. Revocation does not delete sessions.

The [thread tools](./tools.md#collaboration-tools) use these policies and preserve verified remote provenance. Ordinary assistant text is not forwarded. Dangerous authentication-bypass mode keeps bridge receiving disabled and does not bypass bridge management authentication.

### `kiki usage-export`

Export content-free usage from one local Kiki home to vibe-usage/vibecafe, a standard Webhook, or an approved script. This experimental feature is off by default: start the backend with `KIKI_EXPERIMENTAL_USAGE_EXPORT=true`. Setting it only in a later CLI process does not enable an already-running backend. Management requires this home's local-owner credential; remote connection tokens and dangerous authentication-bypass mode do not grant access.

Save a draft, inspect its exact range and fields, then approve that destination once:

```sh
kiki usage-export --home /path/to/home save --input destination.json
kiki usage-export --home /path/to/home preview <id>
kiki usage-export --home /path/to/home test <id>
kiki usage-export --home /path/to/home enable <id> --fingerprint <preview_fingerprint> --agree
kiki usage-export --home /path/to/home sync <id>
kiki usage-export --home /path/to/home status
```

`test` is optional for ordinary enable: it checks authentication and the receiver protocol without sending usage. `preview` does not contact the destination. Use the `id` returned by `save` and the fingerprint returned by the latest `preview`; changing the destination identity or expanding the range requires fresh consent. The displayed account fingerprint identifies a credential locally, not a verified remote account. A new key that cannot be proven to represent the same account needs fresh consent; after queued or delivered data exists, use a new destination instead of changing its identity.

A Webhook draft looks like this:

```json
{
  "draft": {
    "label": "My usage receiver",
    "target": { "kind": "webhook", "endpoint": "https://example.com/usage", "gzip": true, "authentication": "none" },
    "schedule_minutes": 30,
    "scope": { "start_at": 1767225600000, "end_at": null, "include_ephemeral": false, "excluded_workspace_ids": [] }
  }
}
```

Times are Unix milliseconds; buckets are absolute UTC half-hours. Schedules are `0` (manual), `5`, `15`, `30`, or `60` minutes, with jitter. They run only while the backend is alive and do not keep it alive or invoke a model. Ephemeral/private-session usage is excluded unless explicitly selected. Known model identifiers, four mutually exclusive token counts, quality, and a local USD estimate are sent through `kiki.usage.bucket.v1`; unknown prices remain `null` and unknown local aliases use destination-specific opaque identifiers. Prompts, replies, reasoning, tool arguments, attachments, titles, workspace paths, profiles, and real hostnames are not part of the official payload. The receiver can still observe your IP address and usage timing.

Use `authentication: "bearer"` or `"hmac"` with a `secret` object beside `draft`: `{ "value": "YOUR_SECRET", "storage": "keyring" }`. Keyring failure is reported, not silently replaced with a file. To choose a private file explicitly, use `storage: "private-file"` and `acknowledge_file_storage: true`; filesystem permissions protect it, but it is not encrypted at rest. Every `--input` accepts `-` for stdin. Keep credential files private; never put secrets in command-line arguments or send them to a model. Bearer authentication requires HTTPS. Redirects are not followed. Local development HTTP requires an exact `private_grant` matching the host, IP, port, and protocol, not a blanket private-network approval.

For vibe, use `{ "kind": "vibe", "endpoint": "https://example.com/api/usage/ingest" }` and the real service's key. Vibe cannot delete or reliably lower previously accepted totals: conflicting revisions are marked `remote-diverged` without sending them, while unrelated new buckets can continue. For a script, use `{ "kind": "script", "command": "YOUR_COMMAND", "timeout_ms": 60000, "output_limit_bytes": 65536 }`. Its stdin receives the same content-free protocol, and stdout must return its strict receipt (or the separate `kiki.usage.test.v1` handshake during a test). Approval grants the command full OS-user permissions, including independent file and network access; this is not a sandbox and there is no per-batch approval.

Recovery and removal have different meanings:

- `disable <id>` stops new requests and keeps the queue. `sync <id>` scans and sends now using the existing consent. Temporary network failures keep the same durable batch identity and retry with backoff; a protocol/authentication error is shown separately.
- `backfill <id> --input scope.json` previews a changed scope; approve an expanded scope with its new fingerprint. `rebuild --force` invalidates source checkpoints, including same-size/mtime rewrites, without changing wire facts or clearing ACK/revision history.
- `diagnostics`, `export <id>`, `capacity <bytes>`, and `retry <id>` inspect or recover delivery. The default queue limit is 50 MiB; reaching it preserves the old complete projection instead of silently discarding old data.
- `clear-queue <id> --agree` explicitly discards pending data and disables that destination. `remove <id>` removes local configuration and its secret; add `--discard-pending` only when you want to discard an existing queue. Neither deletes remote history, and delivery identity/revision evidence is retained.
- `withdraw <id> --agree` sends versioned deletion tombstones only where the receiver supports deletion. It does not delete local usage; vibe does not support this operation.

For an existing vibe collector, use `handoff plan <id>` on a new native draft, prepare the collector's `kiki-handoff.json` for the returned namespace and future UTC cutoff **T**, then run native `preview` and `test`. `handoff arm <id> --collector-file <file> --fingerprint <preview_fingerprint> --agree` verifies the marker against the saved native credential, activates only that home's collector cutoff, and enables native delivery from the fixed T. It does not read the collector's key or stop its daemon. Different keys are not treated as proof of the same remote account. The collector remains responsible for `<T`, native for `>=T`; offline catch-up keeps T rather than using ACK time. `handoff refresh <id>` reads the collector's safe final receipt; completion requires both the old receipt and a real native ACK. `handoff rollback <id> --cutoff <new_future_R> --agree` keeps native responsible for `[T,R)` and resumes the collector at `>=R`, not an unbounded old scan.

Receiver developers can run the repository's local example with `pnpm exec tsx packages/kap-server/examples/usage-export-receiver.ts` (Node 24). It binds only `127.0.0.1:9080`, persists replacements and deletion tombstones in `usage-receiver.sqlite`, and exposes `POST /usage`. Approve the exact loopback HTTP grant when testing it. A production receiver needs TLS, durable storage, and authentication; the example is not a hosted dashboard.

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
| `--idle-exit <duration>` | Exit after no GUI leases or busy sessions remain for this duration; accepts integer `ms`, `s`, `m`, or `h` (for example `30m`). Omitted by default, so the foreground server stays running |

`kiki web` binds to the local loopback address by default and prints the bearer token in the startup banner; Kiki GUI authenticates automatically via the `#token=` URL fragment.

`kiki web` also carries the Web-access controls — `--temporary`, `--persistent`, `--status`, `--off`, `--revoke [session-id]` — which open this Kiki to a browser on another device and print a single-use entry link. Web access is a full-access entry into this Kiki rather than a read-only share; see [Use Kiki in a browser](../server/local-server.md#use-kiki-in-a-browser) for the session and revocation model. The same operations are available as `/web temporary|persistent|status|off|link|revoke [id]` in the interactive TUI, and under **Settings → Spaces → Web access** in the GUI.

::: info Note
`kiki web` is a compatibility foreground command: it starts an independent server in the current process and does not connect to or manage the shared daemon. Use `kiki serve` to manage the shared daemon lifecycle; use `kiki web` when you need the existing foreground REST/WebSocket/web UI workflow. The legacy `kiki server …` command is no longer supported.
:::

::: danger Warning
`--dangerous-bypass-auth` exposes legacy APIs without authentication: anyone with access to the port can control sessions, files and shell. Connection management and forwarding still require local-owner access; effective peer admission is unavailable, and saved grants cannot authorize incoming peers in this mode. Use only in trusted networks or behind an authenticating reverse proxy, and stop the server when finished.
:::

#### `kiki web rotate-token`

Replace the persistent remote owner token in `<home>/server.token`. The old token becomes invalid and affected peer streams stop; running instances observe the change without restarting. This does not rotate the private local-owner capability in `server.local-owner`. Remote sources must update their credentials before reconnecting.

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
