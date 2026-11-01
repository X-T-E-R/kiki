# Local Server and API

Kiki's local server is the shared daemon. Use `kiki serve` to start, reuse, or stop the daemon shared by the interactive TUI, the desktop GUI, and external callers; it mounts the Kiki GUI for your browser, a REST API (`/api`), and a WebSocket event stream (`/api/ws`). To let a browser on another device into this Kiki, use `kiki web` to turn on [Web access](#use-kiki-in-a-browser) on that same daemon. The Kiki GUI lets you use Kiki in a browser; the REST and WebSocket APIs are for scripts and third-party tools, letting you create sessions, submit prompts, and follow execution from code — all reading and writing the same session data as the TUI and the Kiki GUI.

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

Remote GUI access additionally requires the target's inbound gate to be enabled, its current owner token from `server.token`, and a grant approved for the source home. An owner token alone, a loopback tunnel, or a proxy header does not grant ordinary REST/WebSocket access. The source backend stores the remote credentials and forwards only supported operations for a fixed connection; the renderer does not retain remote secrets. See [`kiki connections`](../reference/command.md#kiki-connections) for invitation and SSH setup. Thread bridges use their own credentials, not GUI grants.

For a trusted local client, carry the local-owner capability as follows:

- **REST**: the `Authorization: Bearer <token>` request header.
- **Kiki GUI**: the desktop GUI and local launchers connect directly with the local-owner capability; a `#token=` fragment in the address is also accepted and is never sent to the server. A browser on another device does not use this path; it signs in with a single-use [Web access](#use-kiki-in-a-browser) link.
- **WebSocket**: clients that can set headers use `Authorization: Bearer`; clients that cannot (such as browsers) pass the token in the handshake subprotocol as `kimi-code.bearer.<token>`.

If the remote owner token leaks, run `kiki web rotate-token`: it replaces `server.token`, invalidates the old remote credential and stops affected peer streams without a restart. It does not rotate `server.local-owner`, so treat exposure of that file as a compromise of local access.

The desktop GUI first checks the instance registry and attaches to an existing server with its local-owner capability; only when none is found does it start its own sidecar. Supported local clients in the same home therefore share the same sessions, regardless of which launcher started the server.

::: warning Note
Two independently provisioned runtimes that do not trust each other — separate services with their own host identity and authority domain — must not share a writable `KIKI_HOME`, must not copy session directories between their homes, and must not copy `device_id` to impersonate the same host. Session indexes, thread attribution, and permission boundaries all depend on a home having a unique identity. The shared daemon, TUI, desktop GUI, and coexisting server instances inside one home are supported and unaffected.
:::

Binding the Web access listener to a non-loopback address (`--host`, including bare `--host`, which targets `0.0.0.0`) requires either `--public-url` pointing at an HTTPS TLS-terminating reverse proxy or `--insecure-no-tls`; without one of those Web access refuses to turn on. You may set `KIKI_PASSWORD` as an additional owner credential; it does not replace the local-owner capability or the per-source grant. The server rate-limits authentication failures automatically.

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
