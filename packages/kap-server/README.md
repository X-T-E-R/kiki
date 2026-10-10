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

## Usage sync credentials

Official VibeCafe device sign-in accepts `{}` and defaults to automatic credential storage. See the [REST login contract](../../docs/en/server/rest-api.md#login-and-usage) for the flow and explicit-storage compatibility. `src/usage/export/secrets.ts` owns the keyring/private-file boundary; automatic saving tries the keyring write first and returns the actual backend. Private files reuse the atomic `writePrivateFile` helper with POSIX 0600/0700 or Windows user ACLs. Directory ACLs include child inheritance so the temporary file is protected before its atomic rename.

`UsageExportService` persists the actual `credential_storage` together with a `credential-cleanup:{id}` metadata entry in the export SQLite store before removing the obsolete backend copy. A cleanup failure does not invalidate a saved credential: the pending entry is retried on another save or server start, including after the destination has been removed. Cold reads use only the recorded backend, never a stale alternate copy. Do not rewrite that field to `auto` or clear a pending cleanup entry to hide a storage failure.

`test/usageExport.integration.ts` covers keyring success, a failing keyring write followed by a real private-file write, cold recovery, repeated sign-in, dual-store failure with an unchanged destination, obsolete-copy cleanup after recovery, and loopback bearer delivery after export consent. The auth exchange and keyring are synthetic; private-file writes and the loopback sink are real. These tests do not prove live VibeCafe approval or access to a user's OS keyring.

## Browser HTML documents

Use `klient.rest.filesystem.openHtmlPreview({ path, root })` to obtain a browser document URL. Both paths are absolute paths on the client's selected host. An authenticated owner's explicit open authorizes that resource tree for this preview, under the same host-file authority as `/api/fs:content`; it does not register a workspace. Supply the actual workspace or declared input root, not a root inferred from the file's directory. The server rejects drive roots, files outside the root, and resource symlinks that resolve outside it. These routes are unavailable when server authentication is bypassed.

The REST calls are `POST /api/fs:html-preview` and `DELETE /api/fs:html-preview/{previewId}`. The open result remains `{ preview_id, url, expires_at, sandbox }`, defined in `@kiki/protocol`. Resolve `url` against the client's server base URL; it is now an absolute URL on a preview-specific `http://{random}.kiki-document.localhost:{port}` origin. Use it as the iframe's `src`, use the returned `sandbox` unchanged, and set `referrerPolicy="no-referrer"` and `allowFullscreen`. The sandbox includes `allow-same-origin` only because this listener has no Kiki app, API or desktop bridge. Never substitute a Kiki-origin resource URL or pass an API token into the document. Keep the frame mounted when switching to source mode; remove it and call `closeHtmlPreview(preview_id)` when its tab closes or its connection changes.

`/html-preview/{capability}/{root-relative-path}` serves the original bytes without parsing or rewriting HTML. Relative scripts, styles, fonts, images, nested documents, query strings and hashes resolve against that URL tree; `../` may reach siblings within the authorized root. The document has its own browser origin: localStorage works across reloads, and modules and relative fetch share that origin. Each open creates a different origin, so storage is not shared with another preview or retained by reopening it. Ordinary browser `file:` restrictions still differ: Chromium rejects local module imports and fetch in the browser fixture even without Kiki.

Document responses carry `Content-Security-Policy: sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads; object-src 'none'`, `Access-Control-Allow-Origin: *` without credential permission, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. The old Kiki-origin resource routes retain an opaque sandbox. Kiki rejects document origins at its API and WebSocket origin gate, including the general loopback CORS allowance. The app CSP permits only the additional frame source `http://*.kiki-document.localhost:*`; its script and other directives are unchanged. Desktop consumers must add that same narrow frame source to their WebView CSP.

The resource listener binds only to `127.0.0.1` and is created by open, not as a global service. A nonlocal client receives `40301` / `html_preview_document_origin_requires_local_connection`; use a GUI on the server host or keep source/download available. Capabilities expire after 30 minutes. Close, expiry, server shutdown and remote connection loss stop active streams and close the listener; already loaded JavaScript continues until the consumer removes the frame. A closed listener produces a network error, while the broker resource endpoint reports `404` / `html_preview_expired`; reopen to recover. A single file without workspace/input context needs the user to choose a resource root; do not silently grant a drive or omit sibling dependencies.

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
