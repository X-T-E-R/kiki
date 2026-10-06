# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that lets models safely call tools exposed by external processes or services — for example, reading GitHub issues, querying databases, or operating the local file system. Kiki acts as an MCP client to connect these external tools and exposes them to the Agent alongside built-in tools (`Read`, `Bash`, `Grep`, etc.) with no behavioral difference.

MCP tool results can carry embedded media. When the current model cannot take an embedded image — because of its format or because the part is over the per-part size cap — Kiki keeps a text notice *and* saves the original into the session's media storage, so nothing is lost. The notice carries the saved file's absolute path and a `kimi-file://` reference; pass the path to `Read` or `ReadMediaFile` to inspect the original. A resource blob in a format Kiki does not deliver is preserved the same way. When the list of saved attachments would crowd the tool output, it is written to a text file and the output keeps a short pointer to it.

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

HTTP and SSE servers support providing static credentials via `headers` or `bearerTokenEnvVar`. When OAuth is needed, run `/kiki-ops help me log in to MCP <server-name>` to complete browser-based authorization. If the server's authorization metadata says it supports `offline_access`, Kiki asks for that scope during login so the authorization can be refreshed later without a new sign-in; otherwise your original scopes are used as they are. A server that advertises the scope may still show an extra consent page, and does not guarantee it issues a refresh token. An already-signed-in server keeps its existing grant and goes on refreshing it — a new scope does not sign you out.

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

## Let an external client use Kiki tools

External clients reverse the direction described above: an MCP-capable model calls Kiki's native file, media, agent, task, History and authorized Memory tools. Kiki keeps the tool activity in a normal session without binding a local model to its main agent. This does not automatically import the external chat, its thinking, or its usage.

This capability is experimental. Enable `KIKI_EXPERIMENTAL_EXTERNAL_CLIENTS=true` when starting the Kiki host, then open **Settings → External clients**. Create a named connection, select the shared workspace and tools, and choose a permission mode. Leave local commands off unless the client needs them. A connection is a permission grant, not a chat: initialization and tool discovery do not create business sessions.

### Connect a local client

Copy the connection's stdio configuration into your MCP client. Its shape is:

```json
{
  "command": "kiki",
  "args": ["mcp", "--client", "client_YOUR_CONNECTION_ID", "--tools"]
}
```

The bridge obtains a separate short-lived credential through the local owner channel. It renews an expired local credential without resubmitting a business error. If the MCP address changes or the host restarts on another port, restart the client's MCP connection; then resume the saved business session instead of recreating its work. Do not place your Kiki owner token in this configuration. The older `kiki mcp --workspace <dir>` delegation mode remains separate.

### Connect over HTTPS

Enable the external MCP listener and configure a stable public HTTPS origin in the same settings page. Add its displayed `/mcp` URL to a client that supports Streamable HTTP and OAuth authorization-code flow with PKCE. Confirm the client's pending authorization in Kiki and select the connection it may use; the external model cannot approve itself. Public HTTPS hosting or a tunnel is a separate service, and a listening port does not prove that discovery is reachable from the client.

This listener serves only MCP, OAuth and health routes, not the GUI, owner API or debug API. Client support and account eligibility depend on the external product; do not assume that every ChatGPT account accepts custom connectors. Kiki uses the installed MCP SDK's protocol negotiation rather than requiring an unpublished protocol version.

### Sessions, retries and recovery

ChatGPT conversation metadata, when supplied by the client as `_meta["openai/session"]`, maps each conversation to its own session under the connection. Other clients call `kiki_session` with `action: "new"` once, retain the returned `session_ref`, and put it in `_kiki.session_ref` on subsequent calls. `resume` is explicit; a copied reference cannot silently attach a new conversation to an old one.

Side effects require a stable `_kiki.idempotency_key`. Retry the same call with the same key; different arguments under that key are rejected. Long operations and approvals return an `operation_id`: query `kiki_operation` instead of resubmitting. If the host stopped before committing an outcome, `outcome_unknown` means inspect the target before an explicit recovery, not that the operation is safe to repeat.

Manual approval requires a real local approval consumer. Without one, the tool is refused. Once an external operation has reached approval, disconnecting the consumer does not resubmit or execute it; it remains pending until approved or cancelled. Revoking a connection stops its unfinished work and children while retaining the records. Changing its access policy cancels unfinished work so an old approval cannot authorize the new policy.

Use `kiki_save_text` or the session's note editor to save supplied text with its source kind. These are external records, not verified user messages or an automatically synchronized chat. **Continue locally** previews saved text and native tool records, then creates a separate local branch; select a local model and send a goal explicitly. The preview reads a bounded subset without calling a model: partial or unavailable material is not an empty report. Large results can be paged with `kiki_operation` and `action: "read"`; follow its `next` request. Text ranges use UTF-16 offsets, media ranges use byte offsets, and media chunks are base64 resources from the saved result rather than the current host file.

Only grant access to clients you trust. Native permissions and workspace file checks remain in force, but local command access can run processes with the host user's privileges; it is not an operating-system sandbox. If the shared folder contains Kiki's private home, give `Glob`/`Grep` a narrower search folder outside that home. Workspace Memory is the default, global Memory requires explicit sharing, and persona administration is not exposed.

## Next steps

- [Plugins](../customization/plugins.md) — Declare MCP servers in a plugin manifest to package and distribute them together
- [Configuration files](../configuration/config-files.md#permission) — Full field reference for permission rules
