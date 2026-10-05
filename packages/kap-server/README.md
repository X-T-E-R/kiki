# KAP server

The local Kiki server: it hosts sessions, exposes them over REST and WebSocket,
and fronts the MCP edge other tools call into.

This is a workspace package. It is marked `private: true`, so it is not
published to npm as its own release. Its surface is documented here for
maintainers and for anyone integrating against a locally running Kiki server;
the commands below run from a Kiki install, not from an npm dependency.

## Klient over HTTP

`POST /api/klient/call` accepts `{ procedure: { scope, service, method, ...scopeIds }, params: [...] }` and returns the standard `{ code, msg, data, request_id }` envelope. Only declared klient procedures are admitted, with contract input and output validation at the host boundary.

`GET /api/klient/events` upgrades to WebSocket. Clients send `subscribe` / `unsubscribe` frames and receive `subscribed`, `event`, or `error` frames correlated by `id`; streaming procedures use `stream*` frames on the same socket.

Both endpoints authenticate with the KAP bearer token. HTTP sends `Authorization: Bearer <token>`; a browser WebSocket sends it as the `kimi-code.bearer.<token>` subprotocol.

## Connecting an external tool to Kiki

For a caller such as Cursor, Claude Code, or Codex:

```sh
kiki serve --ensure --workspace /path/to/workspace --json
kiki seat create --workspace /path/to/workspace --principal cursor --mode auto --json
```

`kiki serve --ensure` reuses a healthy daemon or starts one. The daemon shares its bearer token in `<home>/server.token`, records the workspaces it serves, and exits after the configured idle period only when it holds no active client lease and no running dispatch. `kiki serve --stop` asks for a graceful shutdown through the REST API.

`kiki seat create` creates or reuses the seat for a `(workspace, principal)` pair. The server generates and persists the delegation token, fixes the permission mode and any model/thinking binding, and returns the session binding that both MCP transports use. Manage seats with `kiki seat list`, `kiki seat revoke <seatId>`, and `kiki seat install --client cursor|claude|codex|generic --workspace <dir>`.

The default inbound transport is streamable HTTP on the loopback listener:

```json
{
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <delegation token>" }
}
```

That `Authorization` value is the **seat delegation token**, not the daemon
bearer token. Each MCP session gets its own transport and `createKikiMcpServer`
instance keyed by `Mcp-Session-Id`. An authentication failure returns HTTP 401
with `{ "code", "msg" }`; it is not reported as `40001`.

The stdio transport is still available:

```sh
kiki mcp --workspace /path/to/workspace
```

For compatibility, the startup environment variables
`KIKI_EXTERNAL_PRINCIPAL_ID`, `KIKI_EXTERNAL_SESSION_ID`,
`KIKI_EXTERNAL_DELEGATION_TOKEN`, `KIKI_EXTERNAL_WORKSPACE_PATH`,
`KIKI_EXTERNAL_MODEL_ALIAS`, `KIKI_EXTERNAL_THINKING_EFFORT`,
`KIKI_EXTERNAL_PERMISSION_MODE`, and `KIKI_EXTERNAL_SESSION_TITLE` remain
available.

An MCP caller picks a listed named profile, a task name, and a prompt. It
cannot pick the endpoint, token, session, workspace, model credentials,
permission mode, tools, or profile definitions. `kiki_profiles` is the
cacheable catalog, and `kiki_list` returns only owned children and
continuations. This edge does not configure the external executors or harnesses
Kiki itself uses to run subagents.

## Launcher operations

`scripts/codex-kiki-mcp.ps1` manages the per-workspace KAP processes it spawns.
Every invocation needs the runtime directory produced by the install
orchestration:

- `-RuntimeDir <dir>` — run the launcher (default MCP stdio mode).
- `-RuntimeDir <dir> -ListWorkspaces` — print the recorded workspaces as JSON
  (`key`, `workspacePath`, `port`, `endpoint`, `recordedPid`, `processAlive`,
  `listening`, `status`).
- `-RuntimeDir <dir> -StopWorkspace <key>` — stop one workspace KAP. It tries a
  graceful `POST /api/shutdown` with the workspace bearer token first, then
  falls back to terminating the recorded owner PID, and verifies the port is
  released before reporting success.
- `-RuntimeDir <dir> -StopAllKap` — stop every recorded workspace KAP under the
  runtime.

The launcher never stops a process it did not record. If the recorded port is
held by a process with no signed runtime state, the error names the occupying
PID and process, and you free the port yourself or stop the recorded KAP with
`-StopWorkspace <key>`. The recorded port is pinned by the signed binding and
changes only when the install orchestration re-runs.

When the launcher started its own workspace KAP, it reclaims that process in a
`try/finally` around the MCP process, so the workspace KAP does not outlive the
owning Codex MCP process.

### Workspace binding drift

Each workspace binding is signed and must match the runtime install metadata.
On a drifted field the launcher names each one individually
(`field: expected ... (actual ...)`) rather than reporting a generic
authority-contract failure, then points at the recovery path: re-run the install
orchestration, or stop the workspace with `-StopWorkspace <key>` and delete the
binding directory to re-provision it. Re-provisioning abandons the recorded
delegated session; bindings are never re-signed automatically.

To change the model or thinking effort without re-provisioning, use the
launcher's resign operations:

| Operation | What it does |
| --- | --- |
| `-ListBindings` | Diagnose signature state; works even with a stale runtime HMAC |
| `-ResignBinding <key> -Model <alias> [-ThinkingEffort <value>]` | Re-sign one workspace |
| `-ResignAllBindings` | Re-sign every workspace and update the runtime defaults |

Resigning keeps the delegated session and every other field of the authority
contract intact. Only the model and thinking effort are re-signed, as
per-workspace parameters.
