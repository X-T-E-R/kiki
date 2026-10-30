# `kiki acp` Subcommand

`kiki acp` switches Kiki to **ACP (Agent Client Protocol)** mode: it communicates with an ACP client (such as Zed, JetBrains AI Chat, etc.) via JSON-RPC over stdin/stdout, letting the IDE directly drive kiki's sessions, prompts, and tool calls.

```sh
kiki acp
```

Once started, the command prints no banner and immediately waits for the ACP client to send an `initialize` request on stdin. Logs are written to stderr (as well as the diagnostic log under `<home>/logs/`; default `~/.kiki/logs/`), so the ACP channel itself stays clean.

::: tip Who calls this?
You typically do not need to run `kiki acp` manually — this command is the subprocess entry point for IDEs. For IDE-side configuration, see [Using in IDEs](./ide.md).
:::

## Capability Matrix

The table below lists the capabilities declared by the current ACP adapter layer. The `agentCapabilities` field is returned in full in the `initialize` response, so the IDE can adjust its UI accordingly.

| Capability | Value | Description |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | Supports ACP `image` content blocks (base64 + mimeType) |
| `promptCapabilities.audio` | `false` | Audio prompts not yet supported |
| `promptCapabilities.embeddedContext` | `true` | Client may send `resource`/`resource_link` embedded resource blocks; text content is injected into the prompt as `<resource uri="...">...</resource>`; blob resources are dropped with a warn |
| `mcpCapabilities.http` | `true` | Forwards HTTP MCP services configured by the IDE |
| `mcpCapabilities.sse` | `true` | Forwards legacy SSE MCP services configured by the IDE |
| `loadSession` | `true` | Supports `session/load` to resume an existing session, replaying history on load |
| `sessionCapabilities.list` | `{}` | Supports `session/list` to enumerate the current user's sessions |

## ACP Method Coverage

The spec splits methods into a **stable** surface and an evolving **unstable** surface, so they are listed separately. Everything a normal agent flow needs — initialize → auth → new/load/resume → prompt → cancel, plus file I/O and tool approval — is implemented.

### Stable agent-side — IDE → agent

| Method | Implemented | Description |
| --- | --- | --- |
| `initialize` | Yes | Version negotiation; returns `agentInfo: { name: 'Kiki', version }`, capability matrix, and `authMethods` |
| `authenticate` | Yes | Validates `method_id='login'`; returns `authRequired (-32000)` if token is missing, `invalidParams (-32602)` for unknown ID |
| `session/new` | Yes | Accepts `cwd` / `mcpServers`; returns `configOptions[]` |
| `session/load` | Yes | Restores a session from disk and replays history via `session/update` |
| `session/resume` | Yes | Lightweight sibling of `session/load`; skips history replay |
| `session/prompt` | Yes | Accepts `text` / `image` / `resource` / `resource_link` content blocks; streams `agent_message_chunk` |
| `session/cancel` | Yes | Interrupts the current turn |
| `session/list` | Yes | Enumerates sessions on disk (advertised via `sessionCapabilities.list = {}`) |
| `session/set_mode` | Yes | Compatibility path; dispatches to the same handler as `set_config_option({configId:'mode'})` |
| `session/set_config_option` | Yes | Unified model / thinking / mode picker dispatcher |
| `session/close` | No | |
| `logout` | No | |

### Stable client-side reverse-RPC — agent → IDE

| Method | Implemented | Description |
| --- | --- | --- |
| `session/update` | Yes | Streams `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | Yes | Shared channel for tool approval and question elicitation |
| `fs/read_text_file` | Yes | File reads are executed by the client: Kiki does not read files on your machine directly — it requests file contents from the IDE through this method (advertised via `fsCapabilities`) |
| `fs/write_text_file` | Yes | File writes are executed by the client: Kiki hands the content to the IDE through this method |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | No | Terminal reverse-RPC not connected; shell commands use local execution |

### Unstable surface

| Method | Implemented | Description |
| --- | --- | --- |
| `session/set_model` | Yes | Compatibility path; equivalent to `set_config_option({configId:'model'})` |
| Other methods | No | Includes session lifecycle extensions, buffer sync, inline-edit prediction, provider management, etc. |

All methods not listed above return `methodNotFound`.

## MCP Forwarding

When an ACP client provides `mcpServers` in `session/new`, `session/load`, or `session/resume`, Kiki handles them as follows:

- `http` → Kiki's `transport: 'http'` configuration
- `sse` → Kiki's `transport: 'sse'` configuration
- `stdio` (entries without a `type`) → rejected by default with `invalid_params`; no session is created or restored
- `acp` → discarded with a warn log entry

To use an IDE that sends stdio MCP servers, explicitly start Kiki with `kiki acp --allow-client-stdio-mcp` in that IDE's ACP agent configuration. This trusts the IDE to choose local executables and arguments: its stdio MCP servers run inside Kiki's process tree with Kiki's environment, without a separate Bash approval request. Use this option only for an IDE and MCP configuration you trust. HTTP and SSE MCP servers do not require this option.

### Kiki tools in an external harness

The forwarding above is inbound: an IDE supplies MCP servers to `kiki acp`. When Kiki runs an external harness, it can supply a session-local bridge bound to the exact Kiki session and agent. The adapter must accept stdio MCP; OpenClaw and Pi cannot receive this bridge. Model settings, vendor login and permissions remain the harness's own. You do not copy the managed bridge's temporary credentials into vendor configuration.

The session's capability list shows authentication observations reported by its running adapter. ACP's explicit authentication-required error appears as **Authentication required** for that session. Codex's account updates appear as the engine-reported account status; unrecognized modes stay **Sign-in unknown**. The tooltip identifies the protocol source, working directory and observation time. These saved observations remain readable after the session closes and are cleared when its execution binding changes; they do not replace the connection check in Settings.

Set `inject_kiki_mcp` under `[agent_executor_overrides.<executor-id>.defaults]` to choose the engine default. A Profile's `inject_kiki_mcp` overrides it, and `execution.overrides.inject_kiki_mcp` overrides the Profile for a session. Set the session value to `null` to inherit again. These choices take effect on the next binding, including named external child profiles; cold restore keeps the saved choice. Once an agent binds `false`, existing bridge credentials can no longer list or call its tools.

When injection is omitted at every layer, existing behavior remains: compatible children receive their allowed native tools, while a bare main agent gets a bridge only when context or delegation is requested. Turning injection on does not open extra tool groups. Explicit `kiki_context: []` and `allow_kiki_subagents: false` keep those groups closed.

Opening the bridge does not grant a tool the binding already denies. When an external tool is checked under both its vendor name and the mapped native name, each allow list must include at least one of those names, and a deny of either name blocks the call.

The bridge exposes tools as `kiki_<native tool name>` and rechecks listing and calls under the same identity. It includes allowed plugin and MCP tools for children without bypassing their policy through a second direct forwarding path. Configuration, parent notifications and legacy connection names are covered in [External main-agent delegation](../customization/agents-and-subagents.md#external-main-agent-delegation) and [Kiki context in external main agents](../customization/agents-and-subagents.md#kiki-context-in-external-main-agents). MCP connectivity does not establish whether a particular adapter accepts image or audio prompts; that remains part of the adapter's input contract.

## Next steps

- [Using in IDEs](./ide.md) — Zed / JetBrains configuration steps and troubleshooting
- [`kiki` Command Reference](../reference/command.md) — Complete subcommand list
