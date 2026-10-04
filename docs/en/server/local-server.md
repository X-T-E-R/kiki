# Local Server and API

Kiki ships with a shared daemon and a compatible local server. Use `kiki serve` to start, reuse, or stop the daemon used by the interactive TUI and external callers; use `kiki web` when a foreground process must mount the Kiki GUI in your browser, a REST API (`/api`), and a WebSocket event stream (`/api/ws`). The Kiki GUI lets you use Kiki in a browser; the REST and WebSocket APIs are for scripts and third-party tools, letting you create sessions, submit prompts, and follow execution from code — all reading and writing the same session data as the TUI and the Kiki GUI.

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

With no mode, `serve` runs the daemon in the foreground. `--query --json` only inspects the current instance; `--ensure` attaches to an existing healthy instance or starts one; `--stop` shuts down the reachable instance for the selected home. A live instance with unverifiable identity must be stopped or upgraded before Kiki will start another. `--idle-exit` defaults to `30m`; active client leases (periodically renewed indications that a client is still using the daemon) and running dispatches keep it alive. Explicit `--idle-exit 0ms` keeps a newly started daemon running until explicitly stopped. The TUI performs the same attach-or-start behavior after workspace trust.

## Run the compatible foreground server

Use `kiki web` when a foreground process must serve the browser UI and the REST/WebSocket API:

```sh
kiki web                 # run the server in the foreground and open the browser
kiki web --no-open       # run the server only, don't open the browser
kiki web --port 58628    # pick a specific bind port
```

The server binds to `127.0.0.1:58627` by default (loopback only). If the port is taken it automatically retries with the next one, so multiple instances can coexist on the same machine; each instance registers under `~/.kiki/server/instances/`. The startup banner prints the access URL and the plaintext token:

```text
Local:   http://127.0.0.1:58627/#token=...
Token:   ...
Stop:    Ctrl+C
```

The server runs in the foreground; press `Ctrl-C` for a clean shutdown. For the full option list such as `--host` and `--log-level`, see the [kiki command reference](../reference/command.md#kiki-web).

## Authentication

Local administration and remote peer access use separate credentials. Trusted local launchers read `<home>/server.local-owner`, a private capability persisted across restarts (file mode 0600 on Unix). The desktop GUI, TUI, and local CLI use it to attach to the same home. Keep it private: do not copy it to a remote home or put it in a remote connection profile. Public health checks are an exception to API authentication.

Remote GUI access additionally requires the target's inbound gate to be enabled, its current owner token from `server.token`, and a grant approved for the source home. An owner token alone, a loopback tunnel, or a proxy header does not grant ordinary REST/WebSocket access. The source backend stores the remote credentials and forwards only supported operations for a fixed connection; the renderer does not retain remote secrets. See [`kiki connections`](../reference/command.md#kiki-connections) for invitation and SSH setup. Thread bridges use their own credentials, not GUI grants.

For a trusted local client, carry the local-owner capability as follows:

- **REST**: the `Authorization: Bearer <token>` request header.
- **Kiki GUI**: the URL in the startup banner carries a `#token=` fragment, so opening it in a browser completes sign-in automatically. The fragment is never sent to the server.
- **WebSocket**: clients that can set headers use `Authorization: Bearer`; clients that cannot (such as browsers) pass the subprotocol (a protocol name declared during the WebSocket handshake) `kimi-code.bearer.<token>` (a historical protocol name kept from the upstream Kimi Code era for compatibility).

If the remote owner token leaks, run `kiki web rotate-token`: it replaces `server.token`, invalidates the old remote credential and stops affected peer streams without a restart. This does not rotate `server.local-owner`; treat exposure of that local administrative capability as a compromise of local access, not as something fixed by remote-token rotation.

The desktop GUI first checks the instance registry and attaches to an existing server with its local-owner capability; only when none is found does it start its own sidecar. Supported local clients in the same home therefore share the same sessions, regardless of which launcher started the server.

::: warning Note
This warning targets independently provisioned, mutually untrusted runtimes (for example, two services with distinct host identities and separate authority domains): do not point such runtimes at the same writable home, do not copy session directories between their homes, and do not copy `device_id` to make two homes impersonate the same host — session indexes, thread attribution, and permission boundaries all rely on the uniqueness of a home identity. The shared daemon, TUI, desktop GUI, and coexisting server instances within one home are supported ways of collaborating and are unaffected.
:::

Binding a non-loopback address (`--host`, including bare `--host`, which targets `0.0.0.0`) requires either a TLS-terminating reverse proxy in front of the server or `--insecure-no-tls`; without one of those the server refuses to start. Once it is running on a non-loopback address, you may set `KIKI_PASSWORD` as an additional owner credential; it does not replace the local-owner capability or the per-source grant. The server rate-limits authentication failures automatically.

::: danger
`--dangerous-bypass-auth` still exposes legacy APIs without authentication: anyone who can reach the port can control your sessions, filesystem and shell. Connection management and forwarding remain local-owner-only, and this mode cannot accept peers, enable effective inbound access or issue new grants. Saved allow lists are retained but inactive. Only use it on trusted networks or behind your own authenticating proxy. See the [kiki command reference](../reference/command.md#kiki-web).
:::

## Use Kiki in a browser

Web access is a door into **this** Kiki from a browser on another device. Whoever holds a link can use the Kiki in full, with the same access you have — it is not a read-only share, and a temporary entry is temporary only in how long it stays open.

Turn it on from the GUI under **Settings → Spaces → Web access**, or from the command line:

```sh
kiki web --temporary            # open for eight hours, then close by itself
kiki web --persistent           # stay open until you turn it off
kiki web --status               # is it on, and which browsers are signed in
kiki web --off                  # close it without stopping Kiki or its tasks
kiki web --revoke [session-id]  # sign out one browser, or all of them
kiki web --host --port 58627    # reachable from another device on this network
kiki web --insecure-no-tls      # allow plain LAN HTTP (see the warning below)
```

In the TUI the same operations are `/web temporary|persistent|status|off|link|revoke [id]`, with `--host`, `--port`, `--public-url`, `--insecure-no-tls`, and `--no-open`.

Each run prints a single-use link that signs a browser in. Kiki redeems it for a session cookie held by the browser itself (HttpOnly, `SameSite=Strict`, host-only, `Secure` over HTTPS); no session or root token is ever placed in JavaScript, `localStorage`, or a URL query string. The link is shown once — the server keeps only a digest, so a lost link is replaced by a new one rather than looked up. An already-authorized browser keeps working across service restarts; a new device needs a new link.

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
