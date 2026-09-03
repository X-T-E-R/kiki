# KAP server

## Klient over HTTP

`POST /api/klient/call` accepts `{ procedure: { scope, service, method, ...scopeIds }, params: [...] }` and returns the standard `{ code, msg, data, request_id }` envelope; only declared klient procedures are admitted, with contract input and output validation at the host boundary.
`GET /api/klient/events` upgrades to WebSocket; clients send `subscribe` / `unsubscribe` frames and receive `subscribed`, `event`, or `error` frames correlated by `id` (streaming procedures use `stream*` frames on the same socket).
Both endpoints use the normal KAP bearer: HTTP sends `Authorization: Bearer <token>`, while browser WebSockets send the `kimi-code.bearer.<token>` subprotocol.

## Kiki MCP edge

External delegation is on by default. Start KAP with one admitted
`KIKI_EXTERNAL_PRINCIPAL_ID`, `KIKI_EXTERNAL_SESSION_ID`, and a dedicated
`KIKI_EXTERNAL_DELEGATION_TOKEN`. A host may also provision that exact Session
at startup by passing `KIKI_EXTERNAL_WORKSPACE_PATH`,
`KIKI_EXTERNAL_MODEL_ALIAS`, and `KIKI_EXTERNAL_THINKING_EFFORT` together, plus
optional `KIKI_EXTERNAL_PERMISSION_MODE` (`manual`, `auto`, or `yolo`); an
existing Session must retain the same workspace/model binding. If provisioning
fails, KAP keeps running with the edge disabled and reports the reason through
`GET /api/v1/meta`. Then launch `kiki-mcp` with these environment variables:

- `KIKI_KAP_ENDPOINT`: KAP origin, such as `http://127.0.0.1:58627`
- `KIKI_KAP_TOKEN`: KAP bearer token
- `KIKI_DELEGATION_TOKEN`: the dedicated external-delegation credential
- `KIKI_SESSION_ID`: the operator-selected Session
- `KIKI_WORKSPACE_PATH`: the absolute workspace bound to that Session

The MCP caller can choose a listed named profile, task name, and prompt. It
cannot choose the endpoint, token, Session, workspace, model credentials,
permission mode, tools, or profile definitions.

## Launcher operations

`scripts/codex-kiki-mcp.ps1` also manages the per-workspace KAP processes it
spawns. Every invocation takes the runtime directory produced by the install
orchestration:

- `-RuntimeDir <dir>`: run the launcher (default MCP stdio mode).
- `-RuntimeDir <dir> -ListWorkspaces`: print the recorded workspaces as JSON
  (`key`, `workspacePath`, `port`, `endpoint`, `recordedPid`, `processAlive`,
  `listening`, `status`).
- `-RuntimeDir <dir> -StopWorkspace <key>`: stop one workspace KAP. It first
  tries a graceful `POST /api/v1/shutdown` with the workspace bearer token,
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
