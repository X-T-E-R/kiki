---
title: Session access tokens and terminal status
description: The contract for credentials bound to one session, the terminal hand-off that issues them, and the TUI's OSC 7501 status reports; none of it is built yet.
outline: [2, 3]
---

# Session access tokens and terminal status

This record is the canonical contract for two related pieces of work: a credential bound to one session (a **session access token**), and the TUI's state reports to terminals that support the OSC 7501 program-status protocol, which can also hand such a token to the terminal hosting the TUI. Outside programs will be written against this contract, so it is stated here once; the issues that build it refer to it.

The request came from a terminal product that hosts Kiki's TUI and wants to show the TUI's state, show the same conversation in its own view, send prompts to it and stop a turn. The answer is deliberately general. Nothing in Kiki's code, names, configuration or docs is specific to that product or to any client; a client name may appear only as an example value of `client.name` in tests.

## Purpose

Today a local program that only needs to read one session, send prompts to it and stop its turn has to hold the local owner credential (`<home>/server.local-owner`), which can do everything the server can do. A session access token is the narrower credential: bound to one session, carrying a fixed set of scopes, usable only from the same machine, and held in memory only.

Separately, terminals that show what the programs inside them are doing (idle, working, waiting for the user, finished) can only guess about Kiki from the screen. The OSC 7501 program-status protocol is a vendor-neutral way for a program to tell its terminal its state.

The two pieces are independent. Any terminal that answers the protocol's probe gets Kiki's state, whether or not it ever asks for a token; and tokens are issued through two channels:

- **`owner`**: the local owner mints a token directly through REST or `kiki session-access issue`. This is what a program without a terminal uses.
- **`terminal`**: the terminal hosting the TUI asks through the terminal stream, with a one-time ticket and a verifier only the terminal knows.

A third channel, "the person approves a request shown in Kiki", is not part of this contract, and nothing in the token model may prevent adding it later.

## Session access tokens

### The token

The server keeps tokens in memory only:

```ts
interface SessionAccessToken {
  id: string;                                  // public id, safe to list: "sat_" + ulid
  digest: string;                              // sha256 of the secret; the secret is never stored
  session_id: string;
  scopes: ('read' | 'prompt' | 'abort')[];
  client: { name: string; version?: string };  // name: 1–64 printable characters; version: at most 32
  channel: 'terminal' | 'owner';
  holder_id?: string;                          // terminal channel only
  issued_at: number;
  expires_at: number;
}
```

- The secret is `ksa_` followed by base64url of 32 random bytes. A presented secret is looked up by its digest.
- A `terminal` token always has the scopes `read`, `prompt` and `abort`, lives one hour and cannot be renewed; the terminal asks for a new ticket instead, which proves the TUI is still running and still showing that session. An `owner` token has the scopes the caller lists (at least one) and lives one hour by default; the caller may ask for 60 seconds to 24 hours with `ttl_seconds`.
- Nothing is persisted. A server restart invalidates every token, ticket and holder.
- A token is revoked when its holder releases it, when its holder's presence is lost (see [Holders](#holders-and-presence)), when the owner revokes it, when its session is deleted (`ISessionManager.onDidDeleteSession`), when it expires, and when `[session_access] enabled` is switched off. Revocation closes the token's open WebSocket connections and aborts its in-flight REST requests.

### From this machine only

A request carrying a `ksa_` secret, and every call to `exchange`, is accepted only when it comes from this machine, which means all three of these hold:

1. The socket address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), the same test as external-client credentials use (`packages/kap-server/src/externalClients/routes.ts`).
2. The request is neither a web-access request nor a peer request (`webRequests`, `peerRequests` in `packages/kap-server/src/start.ts`).
3. The request carries no `Origin` header. Web access can share the main loopback port, and a browser's request is otherwise indistinguishable from a local program's.

A `ksa_` bearer that fails this gets HTTP 401 with envelope code `40101`. The limit, documented for users as for external clients: an SSH tunnel or a local reverse proxy still makes a remote caller look local.

### Scopes and operations

These are the only things a token can do. Everything else is refused, and a route added later stays refused until it is registered here with a scope. Wherever a path contains `{id}`, it must equal the token's `session_id`; otherwise the answer is 403.

| Scope | Operations |
| --- | --- |
| `read` | `GET /api/sessions/{id}`, `/status`, `/snapshot`, `/messages`, `/messages/{message_id}`, `/transcript`, `/transcript/ops`, `/transcript/detail`, `/transcript/details`, `/transcript/plan`, `/transcript/user-messages`, `/prompts`, `/approvals`, `/questions`; the large-field read (`POST /api/klient/session-view/{id}/transcript/content`, or an equivalent `POST /api/sessions/{id}/transcript/content` if the klient path cannot be admitted cleanly; the implementation decides and records which); WebSocket `/api/ws` with the frames `client_hello`, `subscribe`, `subscribe_v2`, `unsubscribe`, `unsubscribe_v2`, `ping` and `pong`, limited to the bound session |
| `prompt` | `POST /api/sessions/{id}/prompts` with the restricted body below; the query `receipt=true` is allowed |
| `abort` | `POST /api/sessions/{id}:abort` only, matched exactly as `^/api/sessions/([^/:]+):abort$` |

Refused even though they look session-scoped: the body-addressed batch routes (`GET /api/sessions/query`, `POST /api/sessions:archive`, `:restore`, `:delete-archived`); the per-prompt routes (`GET /api/sessions/{id}/prompts/{prompt_id}`, `POST …/prompts/{tail}`, `POST …/prompts::steer`); the per-message action routes (`POST …/messages/{tail}`); every other `:{action}` on a session; answering approvals and questions; `/api/klient/call` and `/api/klient/events`; and every non-session surface.

Because the router decodes parameters after matching, and the session filesystem registers a catch-all `POST /sessions/{session_id}/{tail}` (`packages/kap-server/src/routes/fs.ts`), raw paths are checked before matching for `ksa_` requests: a path containing `%`, `//`, a `.` or `..` segment, or a trailing slash is refused, and so is `HEAD`.

### Errors

| Situation | Answer |
| --- | --- |
| Missing, invalid, expired or revoked token; a `ksa_` request not from this machine | HTTP 401, envelope code `40101` |
| Valid token, but the operation or session is not allowed | HTTP 403, reason `session_access_scope` |
| A forbidden or malformed field in a request body | The house validation envelope: HTTP 200, code `40001`, with the field named |
| Session access switched off | HTTP 403 `session_access_disabled` (except `exchange`, below) |

The server's auth-failure limiter exists only when it is not bound to loopback (`authFailureLimiter` in `packages/kap-server/src/start.ts`), and tokens are refused off loopback anyway, so no second limiter is added. The exchange rests on a 256-bit ticket that is single use, valid for 60 seconds and useless without its verifier.

### Prompts sent with a token

With a token, `POST …/prompts` accepts only `content` (text blocks only, and a text block may not carry `presentation`), `prompt_id`, `metadata`, and `agent_id` when it is absent or names the main agent. Any other field, in particular `model`, `thinking`, `permission_mode`, `plan_mode`, `plan_gate`, `profile`, `execution`, `disabled_tools`, `skills`, `goal_*`, `delivery_mode` and `admission`, is a validation error naming the field; nothing is silently dropped. Because `promptSubmissionSchema` (`packages/kap-server/src/protocol/rest-prompt.ts`) is a non-strict object that strips unknown keys, this check runs on the raw parsed body in a `preValidation` hook, before the schema.

A prompt sent with a token is stored with `origin: { kind: 'user', via: { client: <token.client.name>, channel } }`. It remains a user message everywhere (TUI, GUI, search, titles, undo); every consumer that switches on `origin` or compares it structurally must keep treating it so. `via` is read back through `GET …/messages`, which returns `metadata.origin` as stored. The transcript origin projection is not extended in this version, because that would need a projection checkpoint format change. `via` must survive the fenced-outbox fallback and durable ingress replay by being persisted with the stored request; if that cannot be done cleanly, a token request refuses with the fence error instead of entering the fallback. A steer that merges several queued prompts rebuilds a plain origin and drops `via`; this is accepted and documented.

### WebSocket

A `ksa_` secret is recognised in the upgrade handler before `audience.authorizeSocket`. A token connection is routed only to the v1 server; it is refused on `/api/klient/events` and on the broker path; and it gets a revocation closer, as peer connections do. On such a connection only the frames in the scope table are accepted. A `subscribe` or `subscribe_v2` naming another session gets an error acknowledgement and subscribes to nothing; terminal, filesystem-watch and every other frame type are refused. The in-frame `token` re-authentication accepts only the same token, so a token connection cannot upgrade itself.

Delivery is an allowlist in `WsConnectionV1.send`, not a blocklist: on the subscription lane, only envelopes of the bound session; on the immediate lane, only `event.session.work_changed`, `event.session.history_rewritten`, `session.meta.updated`, `event.approval.*` and `event.question.*` for the bound session. A token connection never receives `event.plugin.topic` or room changes.

## REST surface

Every route under `/api/session-access` is for the local owner only, except `exchange`. Peer, web-cookie, external-client (`kec_`), seat-delegation and `ksa_` credentials are refused. Web-entry and paired-device credentials must not reach the prefix (web path admission and `matchConnectionOperation`), and it joins the paths that still require the owner credential under `--dangerous-bypass-auth`, so these routes are never unauthenticated.

| Route | Body → data |
| --- | --- |
| `GET /api/session-access` | → `{ version: 1, enabled, terminal_handoff, server_id, tokens: [{ id, session_id, scopes, client, channel, issued_at, expires_at }] }` |
| `POST /api/session-access/tokens` | `{ session_id, scopes, client: { name, version? }, ttl_seconds? }` → the same data as `exchange`; channel `owner`; at least one scope; the session must exist |
| `DELETE /api/session-access/tokens/{token_id}` | Revoke one → `{ revoked: n }` |
| `DELETE /api/session-access/tokens` | Revoke all → `{ revoked: n }` |
| `POST /api/session-access/tickets` | `{ session_id, challenge, holder_id }` → `{ ticket, expires_at }`. `challenge` matches `^[A-Za-z0-9_-]{43}$`; `holder_id` matches `^[A-Za-z0-9_-]{16,64}$` and must have an open presence stream, otherwise HTTP 409; the session must exist. The ticket is base64url of 32 random bytes, valid 60 seconds, single use; only its digest is stored, with the session, challenge, holder and expiry. At most 8 unexpired tickets per holder; older ones are dropped. |
| `GET /api/session-access/holders/{holder_id}/presence` | A long-lived `text/event-stream` response: one `ready` event, then silence. While it is open the holder is present. |
| `POST /api/session-access/release` | `{ holder_id, session_id? }` → `{ revoked: n }`; revokes that holder's tickets and tokens, only for that session if given |
| `POST /api/session-access/exchange` | **No Authorization.** `{ ticket, verifier, client: { name, version? } }` → `{ token, expires_at, session_id, scopes, server_id, server_version, session_access: 1 }` |

### Exchange

`exchange` is added to the auth bypass list (`defaultIsBypassed` in `packages/kap-server/src/middleware/auth.ts`), and it is the only session-access route that is. Every check must pass:

1. The caller is from this machine, by the rule above.
2. The body has exactly the three fields; an unknown field fails.
3. The ticket is known, unexpired and unused.
4. `base64url(sha256(verifier)) === challenge`, where the verifier is hashed as the ASCII bytes of its base64url text, the same convention as PKCE S256.
5. The ticket's holder is still present.
6. `[session_access] enabled` and `terminal_handoff` are both true.

Any attempt that names a ticket consumes it, whether it succeeds or not. Every failure, including a caller that is not on this machine, returns one identical error: HTTP 401, code `40101`, message `invalid_ticket`. The issued token records channel `terminal`, the ticket's holder, and the `client` from the exchange body, so its prompts carry `origin.via = { client, channel: 'terminal' }`.

The ticket can pass through terminal output safely: it is single use, valid for 60 seconds, and useless without the verifier, which never appears in the terminal stream. The exchange only works on the same machine, so when the TUI runs on a remote host over SSH, the hosting terminal still sees status reports but its exchange reaches its own machine's loopback and fails, and it shows status only.

### Holders and presence

A ticket is bound to a **holder** rather than to "the client's connection", because the TUI's event socket has no identity the TUI can name. A holder is identified by `holder_id` and is present while its presence stream is open. When the stream closes, the holder's tickets and tokens are revoked after a 20-second grace, unless a new presence stream for the same `holder_id` opens within it.

## Configuration and CLI

The `[session_access]` section in `config.toml` is registered with `registerConfigSection` in kap-server (keys arrive camel-cased, `terminalHandoff`). The feature is on by default and is not behind an experimental flag.

| Key | Default | When false |
| --- | --- | --- |
| `enabled` | `true` | Every route except `GET /api/session-access` answers 403 `session_access_disabled`; `exchange` answers its single error; token requests are refused; live tokens are revoked through `IConfigService.onDidSectionChange` when the value flips. |
| `terminal_handoff` | `true` | `tickets` answers 403 `session_access_disabled` and `exchange` its single error; owner-issued tokens keep working and are not revoked. |

The CLI is `kiki session-access list | issue --session <id> --scope read,prompt,abort --name <client> [--ttl <dur>] | revoke <token_id|--all>`, modelled on `apps/kimi-code/src/kiki/connections.ts` and registered in `apps/kimi-code/src/kiki/register.ts`. It uses a plain `fetch` after `ensureServer`, since no klient facade exists for this surface. `issue` prints the secret once.

A GUI row for listing and revoking tokens belongs in the planned "Spaces & devices" settings group and is not designed yet.

## Terminal status over OSC 7501

The TUI implements the Program Status Protocol (OSC 7501), revision 0.4. It reports only after a successful probe and never writes any OSC 7501 sequence in a terminal that did not answer it, so every other terminal, tmux included, is unaffected.

### The protocol as Kiki uses it

- A report is `ESC ] 7501 ; key=value:key=value:… ST`, where `ST` is `ESC \` or `BEL`. Pairs are separated by `:` and keys from values by `=`, so no value may contain `:` or `;`. The whole sequence is at most 4096 bytes. Receivers ignore unknown keys. Each report replaces the previous one completely, so every report carries every key the TUI wants kept.
- `state` (required): `idle`, `working`, `done`, `blocked`, `error` or `clear`. `kind`, only with `state=blocked`: `permission`, `question` or `auth`. `app=kiki` on every report. `title`: the session title as base64 of UTF-8, at most 192 bytes before encoding, omitted when there is none. `msg`: base64 of UTF-8, one line, at most 2048 bytes before encoding. Kiki does not use `progress` or `id`.
- A report that breaks a limit is discarded whole by the terminal, so control characters (newlines included) are stripped first, `title` and `msg` are truncated on a UTF-8 boundary before encoding, and `msg` is shortened further if the whole sequence would still exceed 4096 bytes.
- **Probe.** At start-up the TUI writes `ESC ] 7501 ; ? ST` immediately followed by a DA1 query `ESC [ c`. A supporting terminal answers with an OSC 7501 reply whose body starts with `?` (further pairs are ignored) **before** its DA1 reply. If the DA1 reply arrives first, the terminal does not support the protocol, and the process never writes an OSC 7501 sequence. A body starting with `?ticket=` is a ticket request, not a probe reply.

### State mapping

The state is projected from session-core's `SessionViewState`, not rebuilt from ad hoc events.

| TUI situation | Report |
| --- | --- |
| No turn running, nothing pending | `state=idle` |
| The main agent is in a turn | `state=working` |
| A permission approval is pending | `state=blocked:kind=permission`, `msg` a short summary of what is being approved |
| A question is pending | `state=blocked:kind=question`, `msg` the question |
| Sign-in is required before work can continue | `state=blocked:kind=auth` |
| A turn ended normally and the person has not looked yet | `state=done`; where the TUI cannot tell whether the person has looked, `state=idle` is acceptable |
| A turn ended with an error | `state=error`, `msg` a short summary |

The TUI reports once after the probe succeeds; whenever the reported state, kind, title or message changes; whenever the open session changes by any route (`/new`, `/clear`, `/sessions`, `/resume`, a persona switch, deleting the current session, a fork that moves the TUI); and when the server restarted and the TUI reconnected with a new port or `server_id`. It never emits two identical consecutive reports and never re-emits periodically. Every exit path that restores the terminal writes `state=clear` (only if the probe succeeded): the normal stop path, the double Ctrl-C or Ctrl-D exit, and the emergency and signal exits.

The probe reply and ticket requests must never reach the editor or any key handler, whatever screen is showing (dialogs, pickers, paste mode), and must survive being split across reads. The TUI consumes them in an input listener that runs before components, as it already does for focus reports, and coordinates with the DA1 query pi-tui writes for keyboard-protocol negotiation so that neither steals the other's reply.

### Hand-off keys

Every report carries four more keys when all of these hold: session access is enabled, `terminal_handoff` is true, and the TUI's server is the **local** server reached on loopback with the local owner credential. A space on another computer or an SSH server never reports them.

| Key | Value |
| --- | --- |
| `handoff` | `1`: the version of this hand-off contract; its presence means the TUI answers ticket requests |
| `session` | The id of the session the TUI shows; omitted when no session is open and for `--ephemeral` sessions, which report status only |
| `port` | The local server's port; the address is always `127.0.0.1` |
| `server` | The local server's `server_id` |

If any value would contain `:` or `;`, all four keys are omitted rather than emitting a broken report. The TUI reads `enabled`, `terminal_handoff` and `server_id` from `GET /api/session-access` with the owner credential, and the port from its connection URL. With `<ESC>` for 0x1B:

```text
<ESC>]7501;state=working:app=kiki:handoff=1:session=session_abc123:port=58627:server=srv_9f2c<ESC>\
```

### Ticket requests

The terminal writes into the TUI's input `ESC ] 7501 ; ?ticket=<challenge> ST`, where `<challenge>` is 43 base64url characters without padding, `base64url(sha256(verifier))`, and the verifier is a secret the terminal never writes to the terminal stream.

- The request is ignored entirely unless the probe succeeded.
- A malformed challenge, no open session, an ephemeral session, hand-off switched off, or a refusal from the server is answered with an ordinary report without `ticket`.
- Otherwise the TUI makes sure its presence stream is open, calls `POST /api/session-access/tickets` for the session open **at the moment the request is handled**, and emits a full report plus `ticket=<ticket>:challenge=<challenge>`. If the open session changed while the request was in flight, it releases that ticket and answers without it.
- `ticket` and `challenge` appear only in that one answer, never in ordinary reports.
- At most one request is in flight, and a newer request replaces a queued one. At most six requests per minute are answered with a ticket; beyond that they are answered without one.

```text
<ESC>]7501;state=idle:app=kiki:handoff=1:session=session_abc123:port=58627:server=srv_9f2c:ticket=Zk3…:challenge=q1b…<ESC>\
```

The terminal then calls `exchange` with the ticket, its verifier and its own `client` name and version.

The TUI process has one `holder_id`, base64url of 16 random bytes. It opens its presence stream lazily on the first ticket request and keeps it until exit, reopening it when its connection to the server comes back. On every session switch it calls `release { holder_id, session_id: <old> }` before emitting the new report, so a token for the old session stops working. On exit it calls `release { holder_id }`, best effort and bounded to 500 ms, then writes `state=clear`. After a server restart, which invalidates every ticket, token and presence stream, the TUI re-reads `server_id` and the port when its connection returns, and if either changed it reopens the presence stream and reports again at once.

### Versioning

`exchange` returns `session_access: 1` and reports carry `handoff=1`. Both increase together whenever the exchange, the report keys or a token's allowed operations change incompatibly.

## Behaviours token clients rely on

A client holding a token depends on behaviours of prompt submission, turn events and history reads that are believed to hold but have no direct test. Each must be proved by a test against the real server, or its actual behaviour written into the REST docs:

1. A prompt submitted over REST appears as a user message in the transcript projection every TUI and GUI renders.
2. `prompt_id` is idempotent: the same id with the same body returns the first receipt without running twice; the same id with a different body is a conflict.
3. A prompt submitted while a turn runs is queued (receipt `status: 'queued'`) and starts when the turn ends.
4. `turn.started` carries the `promptId` that started it, and `turn.ended` carries `reason`, one of `completed`, `cancelled`, `failed`, `blocked`.
5. Durable `/api/ws` events carry `seq` and `epoch`; reconnecting with `subscribe.cursors` replays the gap; a gap that is too large answers `resync_required`, after which the client reads `snapshot`.
6. A client can read every message after a given one, oldest first. `GET …/messages?after_id=` does not do this (it returns the newest page above the anchor, newest first), and `GET …/transcript/ops?since_seq=` covers only the live journal. If `GET …/transcript?after_turn=` pages strictly forward, it is the documented way; otherwise `messages` gains an ascending option.
7. A message keeps its `id` across a server restart and a session reload. Generated ids fall back to `msg_<sessionId>_<index>` (`packages/kap-server/src/services/messages/messageProjection.ts`), which depends on absolute position, so undo or compaction may change them; the docs must say exactly when an id can change.

`--ephemeral` sessions are not indexed, and `GET …/messages` answers `40401` for them; the TUI does not offer them for hand-off.

## Why the contract has this shape

- **General names.** "Session access token", `ksa_`, `sat_`, `/api/session-access/` and `[session_access]` rather than anything named after terminals, because the owner channel serves any local program and a third channel may follow. For the same reason `exchange` returns `session_access: 1` together with `scopes`, and the configuration has two switches: one for the feature and one for the terminal channel.
- **`via` carries the channel** as well as the client name, so prompts from the owner channel and the terminal channel can be told apart.
- **Holders with presence**, because the TUI cannot name its own event connection to the server; presence also gives the server a way to revoke when the TUI disappears without releasing.
- **Ephemeral sessions report status only**, the smallest rule that keeps unindexed sessions out of the hand-off.
- **No new limiter, and validation errors in the house envelope**, because that is how the server already behaves on loopback and for every other validation error.

## What is built

Nothing of this contract is built. No code in `apps/` or `packages/` mentions `session-access`, `ksa_` or OSC 7501, and the TUI writes no terminal title. The contract builds on what exists: the credential admission path for owner, peer, web and external-client credentials (`packages/kap-server/src/services/connections/audience.ts`), the loopback address test for external-client credentials, `ISessionManager.onDidDeleteSession` (`packages/agent-core-v2/src/app/sessionManager/sessionManager.ts`), `registerConfigSection` and `onDidSectionChange` for configuration, `ServerStartOptions.leaseTtlMs` as the pattern for an injectable clock and a short presence grace in tests, `userPromptOriginSchema` (`packages/protocol/src/events.ts`) as the origin type to extend, `temporarySessionIds` in `apps/kimi-code/src/tui/daemon/daemon-tui.ts` for knowing a session is ephemeral, and pi-tui's input listeners and stdin buffer for consuming terminal replies.

## What is not built

Each piece is tracked by an issue with the title given, in this order:

- **"Add session access tokens scoped to one session (server, owner channel)"**: the token store, enforcement on REST and WebSocket, the restricted prompt body, `via`, management routes, `[session_access]`, the CLI, and the user docs (`server/local-server.md`, `server/rest-api.md`, `configuration/config-files.md`, `reference/command.md`, in en and zh).
- **"Add the terminal hand-off channel for session access tokens (server)"**: tickets, presence, release and `exchange`.
- **"Report the TUI's status to terminals that support OSC 7501 program status"**: the probe, the encoder, the state mapping and `state=clear`. Any change to `packages/pi-tui`, which is vendored, must be minimal and registered as a local divergence in `packages/pi-tui/AGENTS.md` with a guarding test.
- **"Let the hosting terminal request a session access ticket from the TUI"**: the hand-off keys, ticket requests and the holder lifecycle.
- **"Pin down with tests the session behaviours that REST prompt clients rely on"**: the seven behaviours above. It does not depend on tokens and can run in parallel.

## What was never verified

Everything here was settled by reading the code; nothing was run against a server or a terminal.

- That a prompt submitted over REST renders as a user message; `prompt_id` replay and conflict behaviour; the queued-while-busy receipt; `turn.started.promptId` and `turn.ended.reason`; whether `transcript?after_turn=` pages strictly forward; and when message ids change.
- That no content reference passed to the large-field read can resolve into another session.
- Whether the rule that every built-in setting needs a Settings home and en/zh copy applies to plain config keys such as `[session_access]`. It is written for flag ids; `packages/session-core/src/settings/settings.test.ts` decides.
- How a long-lived `text/event-stream` response interacts with the server's idle exit and lease accounting. A presence stream should not keep an otherwise idle server alive beyond what the TUI's own lease already does.

## Open questions

- The TUI keeps the server endpoint it found at start-up and does not follow a server that restarts on another port, so re-reporting after a restart covers only a changed `server_id` on the same endpoint. Following a server to a new port is outside this contract; decide whether it should be.
- Where the GUI lists and revokes tokens, and what it shows, is not designed; it belongs with the "Spaces & devices" settings.
