# Local Server and API

Kiki's local server is the shared daemon. Use `kiki serve` to start, reuse, or stop the daemon shared by the interactive TUI, the desktop GUI, and external callers; it serves a REST API (`/api`) and a WebSocket event stream (`/api/ws`), plus the browser GUI when its assets are installed. To let a browser on another device into this Kiki, use `kiki web` to turn on [Web access](#use-kiki-in-a-browser) on that same daemon. The Kiki GUI lets you use Kiki in a browser; the REST and WebSocket APIs are for scripts and third-party tools, letting you create sessions, submit prompts, and follow execution from code — all reading and writing the same session data as the TUI and the Kiki GUI.

> Make sure Kiki is installed and ready to use first — either logged in via `/login` (in the TUI, or `kiki login`), or with a provider configured in `config.toml`. The server shares the CLI's login state and configuration, so no separate credential is needed for it.

::: warning
The REST and WebSocket APIs described on this page are experimental: interface stability is not guaranteed, and endpoints, fields, and event types may change in any release. When integrating, rely on the `/openapi.json` and `/asyncapi.json` documents served by your version.
:::

## Start or reuse the shared daemon

Use `kiki serve` for the daemon that the interactive TUI and external callers share:

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

With no mode, `serve` runs the daemon in the foreground. `--query --json` only inspects the current instance; `--ensure` attaches to an existing healthy instance or starts one; `--stop` shuts down the reachable instance for the selected home. If a live instance's identity cannot be verified, stop or upgrade it before Kiki will start another. `--idle-exit` defaults to `30m`; active client leases (periodically renewed indications that a client is still using the daemon) and running dispatches keep it alive. Explicit `--idle-exit 0ms` keeps a newly started daemon running until you stop it. The TUI attaches or starts the same way after workspace trust.

## Open it from a browser on another device

`kiki web` no longer runs a foreground server of its own. It finds this home's shared daemon (starting one first, kept running until you stop it, if none is reachable), turns on Web access there, prints a single-use entry link, and returns:

```sh
kiki web                 # turn on temporary Web access, print the link and open it here
kiki web --no-open       # print the link only
kiki web --json          # status and link as JSON for scripts
```

The daemon itself listens only on `127.0.0.1`. Without `--port`, Web access reuses the daemon's local port; `--host`, `--port`, and `--public-url` open a separate listener for browsers only. The terminal output never contains `#token=` or the local-owner capability. See [Use Kiki in a browser](#use-kiki-in-a-browser) below for sessions, revocation, and network options, and the [kiki command reference](../reference/command.md#kiki-web) for every option.

## Authentication

Local administration and remote peer access use separate credentials. Trusted local launchers read `<home>/server.local-owner`, a private capability persisted across restarts (file mode 0600 on Unix). The desktop GUI, TUI, and local CLI use it to attach to the same home. Keep it private: do not copy it to a remote home or put it in a remote connection profile. Public health checks are an exception to API authentication.

For a local client that needs access to one session, use an owner-issued session access token instead of sharing `server.local-owner`. A token secret begins with `ksa_`, has fixed `read`, `prompt`, and `abort` scopes for one session, and expires after one hour by default; the owner can request 60 seconds to 24 hours. Send it as `Authorization: Bearer <token>` on REST requests; a WebSocket client may use that header or `kimi-code.bearer.<token>`. The token works only when the socket is loopback, the request is not from Web access or a peer, and it has no `Origin` header. An SSH tunnel or local reverse proxy can make a remote caller appear local, just as with external-client credentials. Tokens stay in memory and are invalidated when the server restarts. Issue, list, and revoke them with [`kiki session-access`](../reference/command.md#kiki-session-access); see [Session access tokens](./rest-api.md#session-access-tokens) for the routes and allowed operations.

A terminal hand-off can carry its short-lived, single-use ticket through terminal output: it expires after 60 seconds and is useless without the private `verifier` (the secret proof string), which must never appear in that output. Exchange is loopback-only on the machine running Kiki. When the TUI runs on a remote host over SSH, the local terminal can show status but cannot exchange the ticket with that remote server. These routes provide only the server-side capability; the current TUI does not emit hand-off reports. See [Terminal hand-off](./rest-api.md#session-access-terminal-handoff) for the routes and lifecycle.

Remote GUI access requires the target's inbound gate to be enabled and a grant approved for the source home. Pairing with a ten-minute single-use code (`kiki pair`) or one-step SSH connect (`kiki connections ssh connect`) issues a dedicated per-peer credential for that grant and binds a direct peer listener on reachable LAN and Tailscale IPv4 addresses when the daemon is bound to loopback; legacy invitation connections additionally present the target's `server.token`. An owner token alone, a loopback tunnel, or a proxy header does not grant ordinary REST/WebSocket access. The source backend stores the remote credentials and forwards only supported operations for a fixed connection; the renderer does not retain remote secrets. See [`kiki pair` and `kiki connections`](../reference/command.md#kiki-pair) for pairing, invitation, and SSH setup. Thread bridges use their own credentials, and revoking a pairing grant revokes the bridge grant issued with that pairing.

For a trusted local client, carry the local-owner capability as follows:

- **REST**: the `Authorization: Bearer <token>` request header.
- **Kiki GUI**: the desktop GUI and local launchers connect directly with the local-owner capability; a `#token=` fragment in the address is also accepted and is never sent to the server. A browser on another device does not use this path; it signs in with a single-use [Web access](#use-kiki-in-a-browser) link.
- **WebSocket**: clients that can set headers use `Authorization: Bearer`; clients that cannot (such as browsers) pass the token in the handshake subprotocol as `kimi-code.bearer.<token>`.

If the remote owner token leaks, run `kiki web rotate-token`: it replaces `server.token`, invalidates the old remote credential and stops affected peer streams without a restart. It does not rotate `server.local-owner`, so treat exposure of that file as a compromise of local access.

The desktop GUI discovers local instances through its native launcher and authenticates with the local-owner capability. It verifies the service identity and connection protocol before attaching. Different desktop and service builds can connect when the protocol is compatible; status and diagnostics show the service's actual build. If an identified service has an incompatible protocol, Kiki reports the problem instead of starting a second service. When no instance is found, it starts its bundled backend.

After a backend restart or port/token change, the desktop automatically rediscovers the service and verifies the original home, current space, and authentication mode. Temporary failures retry with exponential backoff starting at 1 second and capped at 10 seconds. The draft, current session route, and reading position remain in place. A candidate from another home, space, or authentication mode is rejected while the original view stays open.

Supported local clients in the same home share the same sessions, regardless of which launcher started the server.

::: warning Note
Two independently provisioned runtimes that do not trust each other — separate services with their own host identity and authority domain — must not share a writable `KIKI_HOME`, must not copy session directories between their homes, and must not copy `device_id` to impersonate the same host. Session indexes, thread attribution, and permission boundaries all depend on a home having a unique identity. The shared daemon, TUI, desktop GUI, and coexisting server instances inside one home are supported and unaffected.
:::

Binding the Web access listener to a non-loopback address (`--host`, including bare `--host`, which targets `0.0.0.0`) requires either `--public-url` pointing at an HTTPS TLS-terminating reverse proxy or `--insecure-no-tls`; without one of those Web access refuses to turn on. You may set `KIKI_PASSWORD` as an additional owner credential; it does not replace the local-owner capability or the per-source grant. When the main server listener itself is bound to a non-loopback address, it rate-limits authentication failures automatically; the dedicated loopback Web access listener (including when reached through an SSH tunnel) does not apply per-IP failure rate limiting.

## Use Kiki in a browser

Web access is a door into **this** Kiki from a browser on another device. Whoever holds a link can use the Kiki in full, with the same access you have — it is not a read-only share, and a temporary entry is temporary only in how long it stays open.

Turn it on from the GUI under **Settings → Connection & remote → Access from elsewhere → Web access**, or from the terminal:

```sh
kiki web --temporary            # the default: open for eight hours, then close by itself
kiki web --persistent           # stay open until you turn it off
kiki web --status               # is it on, and which browsers are signed in
kiki web --off                  # close it without stopping Kiki or its tasks
kiki web --revoke [session-id]  # sign out one browser, or all of them
kiki web --host --public-url https://kiki.example.test   # reachable from other devices through a TLS-terminating reverse proxy
kiki web --host --insecure-no-tls                        # allow plain LAN HTTP (see the warning below)
```

In the TUI the same operations are `/web temporary|persistent|status|off|link|revoke [id]`, with `--host`, `--port`, `--public-url`, `--insecure-no-tls`, and `--no-open`.

Each run prints a single-use link that is valid for ten minutes and signs in one browser; **New link for another device** in the GUI and `/web link` in the TUI each sign a fresh one. Kiki redeems it for a session cookie held by the browser itself (HttpOnly, `SameSite=Strict`, host-only, `Secure` over HTTPS); no session or root token is ever placed in JavaScript, `localStorage`, or a URL query string. The server keeps only a digest, so a lost, expired, or used link is replaced by a new one rather than looked up. In always-on mode an already-authorized browser keeps working across service restarts and expires after 30 days unused; in temporary mode browser sessions end with that opening. A new device needs a new link.

Turning Web access off revokes every link and every browser session, and closes the open streams. It does not stop the daemon, the desktop app, or the TUI, and it does not cancel work already started. `kiki serve` and the desktop app are unaffected either way.

::: warning
Plain LAN HTTP (`--insecure-no-tls`) is not encrypted: anyone on the same network can read what is sent. For anything beyond a network you trust, put a TLS-terminating reverse proxy in front and pass `--public-url <https://…>`; Web access then works over that origin.
:::

Web access and remote Kiki connections are different objects. A remote Kiki is another Kiki with its own identity and a per-source grant you approve; a web link is access to this one, owned by whoever owns this machine. Web access does not change peer authorization, and turning it on does not admit any Kiki.

Signed-in browsers can also switch into connected remote Kikis that the local owner explicitly shares. New Web access openings default to an empty selection (`sharedConnectionIds: []`), so no connected remote Kiki is exposed to browsers until you choose it. Under **Settings → Connection & remote → Access from elsewhere → Web access**, check the connected Kikis you want to expose under **Connected Kikis available in browsers** and click **Save shared Kikis**; unchecking a connection and saving revokes browser access to it immediately, closing active streams and event sockets on that remote connection while keeping browsers signed in to this Kiki. Over REST, `GET /api/web-access` reports `sharedConnectionIds`, `PUT /api/web-access` accepts optional `sharedConnectionIds`, and `PUT /api/web-access/shared-connections` with `{ "connectionIds": ["<uuid>"] }` updates the shared set (local-owner only).

## Drive a session over the API

The minimal flow with curl: check the server → create a session → subscribe to events → submit a prompt → read history back. The examples assume the server runs at the default address and its trusted local-owner capability is stored in the shell variable `TOKEN`.

1. Check server status:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/meta
```

Every JSON response is wrapped in a uniform envelope — `{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`. The business outcome lives in `code` (`0` means success); the HTTP status only reports transport-level results.

2. Create a session; `metadata.cwd` sets the working directory:

```sh
curl -s -X POST http://127.0.0.1:58627/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

The returned `data.id` (shaped like `session_...`) is the session id used by every subsequent request.

3. Connect to the WebSocket and subscribe to session events. Any WebSocket client works; below is a dependency-free Node.js script (Node.js 22+ ships a built-in `WebSocket` client):

```js
// subscribe.mjs — usage: TOKEN=... node subscribe.mjs session_...
const ws = new WebSocket('ws://127.0.0.1:58627/api/ws', [
  `kimi-code.bearer.${process.env.TOKEN}`,
]);
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { session_ids: [process.argv[2]] },
    }),
  );
```

4. Submit a prompt:

```sh
curl -s -X POST http://127.0.0.1:58627/api/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "Introduce this repository in one sentence"}]}'
```

The subscriber sees, in order: `turn.started` (turn begins) → `assistant.delta` (streaming text increments) → `tool.call.started` / `tool.result` when tool calls happen → `turn.ended` (turn finishes).

5. Read history back over REST at any time:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/sessions/<session_id>/messages?page_size=20"
```

## Live specification documents

While running, the server describes itself with two specification documents, both requiring the bearer token:

- `GET /openapi.json` — an OpenAPI document for the REST API, with request/response schemas for every endpoint; import it into Swagger UI, Postman, and similar tools.
- `GET /asyncapi.json` — an AsyncAPI document for the WebSocket protocol, covering control frames and event types.

## Next steps

- [Server API](./rest-api.md) — full REST endpoint inventory, error codes, WebSocket events, and the transcript protocol
- [kiki command](../reference/command.md#kiki-web) — all `kiki web` command-line options
