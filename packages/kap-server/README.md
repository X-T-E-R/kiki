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

Ordered session views use `/api/klient/session-view/{sessionId}`. Transcript pages target 1 MiB and content segments target 256 KiB. These are scheduling targets, not access limits: an indivisible identity, object key or reference header may exceed them. Follow `next_cursor`, `next` and newly returned `contentRefs` until complete; clients must not reject successful reading responses merely because they exceed a local page budget. A changed content revision returns `40922`; refresh the preview before continuing. `40923` means canonical navigation is still preparing and can be read again. Source corruption and IO failures remain errors rather than empty history, and disconnecting cancels the current reader.

A windowed baseline is a continuous suffix of the available timeline. When resident turns have been released, historical standalone markers before that suffix remain recoverable through pages but must not become the baseline's `olderCursor`. Continue from the first emitted item after both turn and byte windowing; a marker is a valid boundary only when it belongs to that suffix.

Cold page previews share a 4 MiB, 15-second source-verified cache; canonical bodies stay in source-backed detail reads. Large detail retention uses one expiring slot, configured in `config.toml`:

```toml
[transcript_memory]
tail_turns = 20
max_agent_bytes = 16777216
max_detail_cache_bytes = 268435456
```

`max_detail_cache_bytes` is a nonnegative integer byte budget, defaulting to 256 MiB. `0` disables the large-detail slot, not reading; the ordinary 4 MiB detail cache remains. Raising it can avoid replaying a large target repeatedly. Changes apply on the next cache admission or eviction check and do not cancel an active read. The resident settings govern the live tail, not how much saved history can be opened.

## Browser HTML documents

Use `klient.rest.filesystem.openHtmlPreview({ path, root })` to obtain a browser document URL. Both paths are absolute paths on the client's selected host. An authenticated owner's explicit open authorizes that resource tree for this preview, under the same host-file authority as `/api/fs:content`; it does not register a workspace. Supply the actual workspace or declared input root, not a root inferred from the file's directory. The server rejects drive roots, files outside the root, and resource symlinks that resolve outside it. These routes are unavailable when server authentication is bypassed.

The REST calls are `POST /api/fs:html-preview` and `DELETE /api/fs:html-preview/{previewId}`. The open result is `{ preview_id, url, expires_at, sandbox }`, defined in `@kiki/protocol`. Resolve `url` against the client's server base URL. Use it as the iframe's `src`, use the returned `sandbox`, and set `referrerPolicy="no-referrer"` and `allowFullscreen`. Do not add `allow-same-origin` or pass an API token into the document. Keep the frame mounted when switching to source mode; remove it and call `closeHtmlPreview(preview_id)` when its tab closes or its connection changes.

`/html-preview/{capability}/{root-relative-path}` serves the original bytes without parsing or rewriting HTML. The browser resolves relative scripts, styles, fonts, images, nested documents, query strings and hashes against that URL tree; `../` may reach siblings within the authorized root. Responses carry `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; object-src 'none'`, `Access-Control-Allow-Origin: *` without credential permission, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. This allows resource CORS requests from the document's opaque origin while keeping it separate from the parent and API. Storage and other origin-dependent browser features remain unavailable in this sandbox. Kiki's app CSP is unchanged.

Capabilities expire after 30 minutes. Closing one immediately stops active streams and rejects subsequent resource loads; already loaded JavaScript continues until the consumer removes the frame. A `404` with `html_preview_expired` requires reopening the preview. A single file without workspace/input context needs the user to choose a resource root; do not silently grant a drive or omit sibling dependencies.

Remote clients use the same typed call and the existing authenticated connection broker. The URL is a local broker capability, never a remote bearer token, and resources are fetched from the selected remote host. A peer connection currently cannot mint a host-root grant: `40301` / `html_preview_target_owner_grant_required` means the target owner must authorize the document's resource root. Treat that as unavailable remote preview authorization, not malformed HTML, and keep source/download available. This slice does not provide that target-owner grant exchange and must not fall back to reading a similarly named local file.

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

Context tools advertise their original JSON Schema in `tools/list`, including
root unions and local references. Tool calls still use the same registered
validator before reaching the context procedure; a complete catalog is not
permission to omit required arguments or bypass the bound session's policy.

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
