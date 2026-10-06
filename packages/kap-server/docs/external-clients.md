# External-client host

The external-client domain exposes native Kiki tools to a trusted MCP client while retaining the existing Session/Agent execution, permission, approval, task and transcript paths. The transport adopts the installed MCP SDK; grant-to-session mapping, persistent operation admission and source-aware records are Kiki-specific adapters. It does not implement an external model executor, browser session capture or an OS sandbox.

## Ownership and entry points

`src/externalClients/contracts.ts` owns persisted connection/session and operation types. `host.ts` owns admission, session binding and native execution; `access.ts` supplies grant-restricted History and Memory seeds. `results.ts` and `resultPages.ts` translate native results to bounded MCP responses and authorized full-result pages. `listenerManager.ts` adapts the host to the independent transport in `src/mcp/externalClientTransport/`.

Owner management is the authenticated `/api/external-clients` REST surface, mirrored by `klient.rest.externalClients`. Management remains owner-only even when general server auth bypass is enabled; web/peer credentials cannot confirm OAuth consent. Creating a local credential additionally requires a loopback socket. The independent MCP listener has no owner, GUI or debug routes. `kiki mcp --client <id> --tools` requests a distinct short-lived credential with an owner-authenticated POST and keeps it in the bridge process, not arguments or URLs.

The stdio bridge reads the live HTTP catalog for every `tools/list`. A local HTTP 401 triggers one shared in-memory credential renewal and at most one retry, before business admission; MCP business errors and other HTTP outcomes are not blindly retried. A changed credential endpoint explicitly requires restarting the bridge. HTTP session identity and the saved business session remain separate.

The `external_clients` flag defaults off. The public setup and recovery view is [`docs/en/server/mcp.md`](../../../docs/en/server/mcp.md#let-an-external-client-use-kiki-tools), with its [Chinese mirror](../../../docs/zh/server/mcp.md#让外部客户端使用-kiki-工具). Default-on and public release require that view and the actual client integration to remain aligned.

## Persistence and authorization

All business documents use `IAtomicDocumentStore` under the bootstrap credentials scope. Connection, token-hash, session mapping, catalog snapshot and operation keys stay in their owning subdirectory. Native filesystem `list(scope)` enumerates immediate children, so inventories use the full directory as scope rather than expecting a recursive key-prefix scan. OAuth uses one atomic `state.json` in its own scope.

MCP transport sessions are not business sessions. A valid grant plus `openai/session` metadata maps one external conversation to one business session. Without that metadata, clients create or explicitly resume a session and carry `_kiki.session_ref`. Every call re-resolves the grant. References and operation IDs do not authorize access on their own.

A session freezes its workspace root; editing a connection does not move existing session cwd. Before each native resolution/execution, the connection's tool and permission ceilings are applied. File checks use resolved paths, restrict access to that session workspace and reject the host home even when it lies below the workspace. Recursive `Glob`/`Grep` roots that contain the private home are refused with a narrower-path recovery, rather than silently searching that subtree. Read-only access to the caller agent's native tool-result artifacts is retained. Explicit command access permits host-user processes and is not an OS isolation claim.

History seeds check requested workspace, target session's authoritative workspace and grant scope, including ref/cursor reads. Memory seeds intersect actual Store scopes; global requires explicit sharing and persona administration is denied. External claims of human memory provenance are downgraded to derived provenance. Child agents inherit the same session-level grant limits.

Policy edits compare normalized effective values: real workspace path, permission mode, tool set, command access, Memory scope set, History scope and enabled status. Renaming, identical full forms, set reorderings and equivalent paths do not stop work. A real policy change persists the new grant and cancels unfinished operations/children; completed facts remain.

## Operations and records

Side effects require a stable key. Admission durably stores the argument hash and operation ID before execution. Same key and arguments reuse the receipt; different arguments fail. Sessions serialize native operations, while operation get/cancel/read bypass that queue. Transport disconnect does not own an admitted operation's cancellation signal.

A native approval request must have an actual consumer at admission. For an external main it is then detached from consumer liveness, so later consumer disconnect retains the pending request. No consumer is synthesized. Stop, revoke and real policy changes abort and drain in-flight operations through native cancellation. Restart marks unfinished admitted operations `outcome_unknown`; it never silently resubmits them.

`ExternalClientRecorder` emits durable external activity and a native external-origin turn without a prompt. Native tool call/result facts stay paired. Explicit saved text has a `recordId`, source connection/session, kind and optional related operations/source time; History uses `role=record` and the transcript uses an `external.text` marker, not a user/assistant bubble. The sourced internal `external_record` material is available to local continuation but hidden from the chat-bubble projection.

External main bindings use `driver=external` and no model alias. Image passthrough is available; video upload is not advertised. Task completion facts and mailbox messages remain available, but neither automatically schedules a default-model step for external main. Native child requests still select an actual local model/profile.

Local continuation calls native fork with `externalMaterialOnly=true`. It copies main activity and saved material, excludes child execution state and main task/cron state, and preserves the source session's children. It refuses a currently running external main operation. The target starts without an automatic model request; explicit local model binding clears the copied external driver.

The owner-only materials preview reuses `TranscriptService.readColdSnapshotBounded`, not a separate history store. `GET /api/external-clients/sessions/:id/materials` / `klient.rest.externalClients.materials(id)` reads at most 2 MiB / 10,000 main-wire records without resuming the session or requesting a model. It returns up to 12 saved-text/tool-record excerpts with source and numeric HistoryRead turn references. `complete`, `partial`, and `unloaded` are distinct states; only complete coverage with no items means no reported material. The preview is bounded sampling, not a fork watermark or a promise to show every copied record.

The listener's public URL is a canonical HTTPS origin: credentials, non-root paths, queries and fragments are rejected before altering the listener. Local credential discovery returns the actual bind family's loopback URL independently of that public origin.

## Full results and proof boundary

Receipts cap MCP text and inline media while pointing to `kiki_operation action=read`. Paging authorizes the operation under the current connection, then resolves only its saved result and session-local historical bytes. Text offsets are UTF-16 and media offsets are bytes; the returned continuation carries the next range. Missing historical bytes are an explicit error, never replaced by a current host file.

`test/externalClients.integration.ts` exercises the real host, native executor and SDK client with isolated home/workspaces and a local fake model provider. It covers no-default-model tools, chat/ref mapping and idempotency, cold records, native approval admission/disconnect/revoke, equivalent-policy edits versus real narrowing, Memory/History/home isolation, historical media, native background child completion, material-only local continuation and host-restart replay. `test/externalClientTransport.test.ts` covers SDK HTTP/stdio, OAuth PKCE/resource/revoke and real atomic-document recovery. The CLI command fixture verifies the credential POST seam.

These fixtures do not establish an external product account's connector eligibility, public HTTPS discovery, a real tunnel, or a paid provider's behavior. Release integration must check those only under the corresponding authorization; listener readiness remains separate from public reachability.
