# KAP server

## Klient over HTTP

`POST /api/klient/call` accepts `{ procedure: { scope, service, method, ...scopeIds }, params: [...] }` and returns the standard `{ code, msg, data, request_id }` envelope; only declared klient procedures are admitted, with contract input and output validation at the host boundary.
`GET /api/klient/events` upgrades to WebSocket; clients send `subscribe` / `unsubscribe` frames and receive `subscribed`, `event`, or `error` frames correlated by `id` (streaming procedures use `stream*` frames on the same socket).
Both endpoints use the normal KAP bearer: HTTP sends `Authorization: Bearer <token>`, while browser WebSockets send the `kimi-code.bearer.<token>` subprotocol.

## Kiki MCP edge

The recommended flow for an external caller such as Cursor, Claude Code, or Codex calling Kiki (inbound) is:

```sh
kiki serve --ensure --workspace /path/to/workspace --json
kiki seat create --workspace /path/to/workspace --principal cursor --mode auto --json
```

`kiki serve --ensure` reuses a healthy daemon or starts one. The daemon shares the bearer token in `<home>/server.token`, records the workspaces it serves, and exits after the configured idle period only when it has no active client lease or running dispatch. `kiki serve --stop` requests a graceful shutdown through the REST API.

`kiki seat create` creates or reuses the seat for a `(workspace, principal)` pair. The server generates and persists the delegation token, fixes the permission mode and optional model/thinking binding, and returns the Session binding used by both MCP transports. Use `kiki seat list`, `kiki seat revoke <seatId>`, and `kiki seat install --client cursor|claude|codex|generic --workspace <dir>` for lifecycle and client configuration.

The default inbound transport is streamable HTTP on the loopback listener:

```json
{
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <delegation token>" }
}
```

`Authorization: Bearer` is the seat delegation token, not the daemon bearer token. Each MCP session gets its own transport and `createKikiMcpServer` instance keyed by `Mcp-Session-Id`. Authentication failures return HTTP 401 with `{ "code", "msg" }` and are not folded into `40001`.

The stdio transport remains available through:

```sh
kiki mcp --workspace /path/to/workspace
```

The startup environment variables `KIKI_EXTERNAL_PRINCIPAL_ID`, `KIKI_EXTERNAL_SESSION_ID`, `KIKI_EXTERNAL_DELEGATION_TOKEN`, `KIKI_EXTERNAL_WORKSPACE_PATH`, `KIKI_EXTERNAL_MODEL_ALIAS`, `KIKI_EXTERNAL_THINKING_EFFORT`, `KIKI_EXTERNAL_PERMISSION_MODE`, and `KIKI_EXTERNAL_SESSION_TITLE` remain available for compatibility.

The MCP caller can choose a listed named profile, task name, and prompt. It cannot choose the endpoint, token, Session, workspace, model credentials, permission mode, tools, or profile definitions. `kiki_profiles` is the cacheable catalog; `kiki_list` returns owned children and continuations only. This edge does not configure the external executors or harnesses that Kiki uses to run subagents (outbound).

## Launcher operations

`scripts/codex-kiki-mcp.ps1` also manages the per-workspace KAP processes it
spawns. Every invocation takes the runtime directory produced by the install
orchestration:

- `-RuntimeDir <dir>`: run the launcher (default MCP stdio mode).
- `-RuntimeDir <dir> -ListWorkspaces`: print the recorded workspaces as JSON
  (`key`, `workspacePath`, `port`, `endpoint`, `recordedPid`, `processAlive`,
  `listening`, `status`).
- `-RuntimeDir <dir> -StopWorkspace <key>`: stop one workspace KAP. It first
  tries a graceful `POST /api/shutdown` with the workspace bearer token,
  then falls back to terminating the recorded owner PID, and verifies the port
  is released before reporting success.
- `-RuntimeDir <dir> -StopAllKap`: stop every recorded workspace KAP under the
  runtime.

The launcher never stops an unrecorded process. If the recorded port is held by
a process with no signed runtime state, the error names the occupying PID and
process and tells you to free the port yourself (or stop the recorded KAP with
`-StopWorkspace <key>`); the recorded port is pinned by the signed binding and
only changes when the install orchestration re-runs. When the launcher started
its own workspace KAP, it reclaims that process in a `try/finally` around the
MCP process, so the workspace KAP does not outlive the owning Codex MCP
process.

### Workspace binding drift

Each workspace binding is signed and must match the runtime install metadata.
When a field drifts, the launcher reports each drifted field individually
(`field: expected ... (actual ...)`) instead of a generic authority-contract
failure, then points at the recovery path: re-run the install orchestration, or
stop the workspace with `-StopWorkspace <key>` and remove the binding directory
to re-provision it. Re-provisioning abandons the recorded delegated Session;
bindings are never re-signed automatically.

To change the model or thinking effort without re-provisioning, use the resign
operations on the launcher script: `-ListBindings` (diagnose signature state,
works even with a stale runtime HMAC), `-ResignBinding <key> -Model <alias>
[-ThinkingEffort <value>]` (re-sign one workspace), or `-ResignAllBindings`
(re-sign every workspace and update the runtime defaults). Resigning keeps the
delegated Session and every other field of the authority contract intact; only
the model and thinking effort are re-signed as per-workspace parameters.
