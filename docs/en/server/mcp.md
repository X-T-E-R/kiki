# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that lets models safely call tools exposed by external processes or services — for example, reading GitHub issues, querying databases, or operating the local file system. Kiki acts as an MCP client to connect these external tools and exposes them to the Agent alongside built-in tools (`Read`, `Bash`, `Grep`, etc.) with no behavioral difference.

MCP tool results can carry embedded media. When the current model cannot take an embedded image — because of its format or because the part is over the per-part size cap — Kiki keeps a text notice *and* saves the original into the session's media storage, so nothing is lost. The notice carries the saved file's absolute path and a `kimi-file://` reference; pass the path to `Read` or `ReadMediaFile` to inspect the original. A resource blob in a format Kiki does not deliver is preserved the same way. When the list of saved attachments would crowd the tool output, it is written to a text file and the output keeps a short pointer to it.

## Share Kiki tools with another client

Kiki can also serve its native tools to an explicitly authorized MCP client. The feature is available by default; it does not start a listener or authorize a client until you configure access.

1. In Settings → model providers → connection services, add an external client and choose its shared tools and permission ceiling. These are access settings, not a workspace or conversation.
2. Create a conversation in Kiki, choose that external client, and select the workspace, worktree, Profile, and permission mode there. Kiki binds the resolved workspace to the conversation; the client cannot supply an arbitrary working directory.
3. Configure the other application's MCP entry with the local command below, replacing `CONNECTION_ID` with the connection's ID. For remote access, enable the MCP listener in connection services and use its displayed HTTPS URL; approve the client's authorization request in Kiki.

```sh
kiki mcp --client CONNECTION_ID --tools
```

Connecting alone does not create a conversation. Before a conversation is attached, the tool catalog contains only `kiki_session`, `kiki_operation`, and `kiki_save_text`. Call `kiki_session` with `{"action":"list"}`, then explicitly resume a shared conversation with `{"action":"resume","session_ref":"SESSION_REF"}`. Keep the returned reference in `_kiki.session_ref` on native tool calls. After attachment, the catalog exposes the selected conversation's shared native tools and sends a tool-list change notification. To start another conversation with the same workspace and settings, call `kiki_session` with `action: "new"`, that `session_ref`, and a stable `_kiki.idempotency_key`.

For side-effecting calls, keep the same `_kiki.idempotency_key` when retrying. Use `kiki_operation` to query or cancel an accepted operation instead of resubmitting it; its `read` action pages the saved original result. `kiki_save_text` saves only text the external client explicitly supplies—it does not synchronize the client's private chat automatically. Pause or revoke the connection in Settings to stop its access.

## Connection Methods

Kiki supports three MCP server connection methods:

- **stdio**: The CLI starts the local MCP server as a child process and communicates via standard input/output. Suitable for local command-line tools.
- **HTTP**: The CLI connects to an already-running HTTP endpoint. Suitable for remote services or processes that need to run persistently.
- **SSE**: The CLI connects to a legacy HTTP+SSE endpoint (Server-Sent Events, a streaming HTTP mechanism). Prefer HTTP for new MCP servers, but use `transport: "sse"` when a service still exposes only the older SSE transport.

## Configuration

MCP server configuration is written in `mcp.json`, at two levels:

- **User level**: `~/.kiki/mcp.json` (or `$KIKI_HOME/mcp.json`), shared across projects
- **Project level**: `.kiki/mcp.json` in the working directory, effective only for the current repository

The legacy `.kimi-code/mcp.json` path is not read.

Entries with the same name: the project-level entry takes precedence and overrides the user-level entry.

Run `/kiki-ops help me configure MCP` in the TUI to interactively add, edit, or delete servers without manually editing the JSON file. Run `/mcp` to view the connection status of all current servers.

Deleting a server from the configuration does not interrupt open sessions: the server stays listed in `/mcp` as `removed`, its tools remain visible there, and calls to them fail with a removal notice, while new sessions do not register the tools at all. Conversely, a server added mid-session — by editing `mcp.json` or installing a plugin — is not registered in already-open sessions; it only joins sessions created later.

When Kiki finds project-level MCP servers in an untrusted folder, it shows each server's transport and launch target in the workspace trust prompt. The prompt defaults to `Trust this folder`; review the listed command and arguments or remote URL before confirming. Trusting the folder enables the project-level MCP servers for that workspace.

Structure of `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "legacy-events": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

Entries with a `command` field are stdio servers; entries with a `url` field and no `transport` are HTTP servers. For legacy SSE servers, set `transport` to `"sse"` explicitly.

Optional fields:

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | Environment variables injected into the child process |
| `cwd` | `string` | stdio | Working directory for the child process |
| `headers` | `Record<string, string>` | HTTP, SSE | Static request headers appended to every request |
| `bearerTokenEnvVar` | `string` | HTTP, SSE | Name of an environment variable that contains a bearer token |
| `enabled` | `boolean` | All | Set to `false` to disable this server |
| `startupTimeoutMs` | `number` | All | Connection timeout from `1` to `2147483647` milliseconds; default `30000` |
| `toolTimeoutMs` | `number` | All | Timeout from `1` to `2147483647` milliseconds for a single tool call |
| `enabledTools` | `string[]` | All | Tool allowlist |
| `disabledTools` | `string[]` | All | Tool blocklist |

You do not have to set the connection timeout or the single tool-call timeout per server: `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` in `config.toml` or the `KIKI_MCP_STARTUP_TIMEOUT_MS` / `KIKI_MCP_TOOL_TIMEOUT_MS` environment variables change the global defaults. Precedence is: per-server field > environment variable > `config.toml` > built-in default. See [Configuration files](../configuration/config-files.md#mcp).

HTTP and SSE servers support providing static credentials via `headers` or `bearerTokenEnvVar`. When OAuth is needed, run `/kiki-ops help me log in to MCP <server-name>` to complete browser-based authorization.

Plugins can also declare MCP servers in their manifest. Servers declared by a plugin are enabled by default and can be disabled or re-enabled in `/plugins`: disabling or removing stops the tools in open sessions — calls fail with a removal notice — while re-enabling reconnects the server in open sessions immediately and restores its tools, as long as the server already existed when the session was created (this includes re-enabling an `enabled: false` entry in `mcp.json`). A brand-new server still follows the rule above: it only joins sessions created later. See [Plugins](../customization/plugins.md#mcp-servers-in-plugins) for details.

::: warning Note
stdio entries in a project-level `.kiki/mcp.json` execute local commands when a session starts. Only enable these in repositories you trust.
:::

## Tool Naming and Permissions

MCP tools are named in the format `mcp__<server>__<tool>`, for example `mcp__github__create_issue`. Permission rules support `*` and `**` wildcards, for example `mcp__github__*` matches all tools under that server. MCP tool parameters are not included in permission matching.

Calls that do not match any permission rule trigger an approval request. Selecting "Approve for this session" in the approval dialog automatically allows subsequent calls of the same kind within the current session.

You can also pre-configure permanent rules in `[[permission.rules]]` in `config.toml`:

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

For the full permission rule syntax, see [Configuration files](../configuration/config-files.md#permission).

## Security

When connecting to external MCP servers, be aware of:

- Only connect to servers from trusted sources
- Verify that tool names and parameters look reasonable in approval requests
- Keep manual approval for high-risk tools (file writes, command execution, etc.); avoid using `mcp__*` wildcards to allow all tools at once

::: warning Note
In YOLO mode, MCP tool calls are automatically approved. Only use this mode when you fully trust the MCP servers you have connected.
:::

## Next steps

- [Plugins](../customization/plugins.md) — Declare MCP servers in a plugin manifest to package and distribute them together
- [Configuration files](../configuration/config-files.md#permission) — Full field reference for permission rules
