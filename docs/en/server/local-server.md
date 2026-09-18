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

With no mode, `serve` runs the daemon in the foreground. `--ensure` attaches to an existing healthy instance or starts one and returns its connection; `--stop` shuts down the reachable instance for the selected home. `--idle-exit` defaults to `30m`, while active client leases and running dispatches keep the daemon alive. The TUI performs the same attach-or-start behavior after workspace trust.

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

Every `/api/*` endpoint requires a bearer token (any request carrying this string is treated as authorized). The token is generated on the first server boot, persisted at `~/.kiki/server.token` (file mode 0600), and reused across restarts.

Pick the carrying method that fits your client:

- **REST**: the `Authorization: Bearer <token>` request header.
- **Kiki GUI**: the URL in the startup banner carries a `#token=` fragment, so opening it in a browser completes sign-in automatically. The fragment is never sent to the server.
- **WebSocket**: clients that can set headers use `Authorization: Bearer`; clients that cannot (such as browsers) pass the subprotocol (a protocol name declared during the WebSocket handshake) `kimi-code.bearer.<token>` instead.

If the token leaks, run `kiki web rotate-token`: the new token is written to `server.token` immediately, the old one stops working at once, and running instances pick up the new token without a restart.

The desktop GUI uses this same home token. On launch it looks for a running server in the instance registry and attaches to it when one is alive; only when none is found does it start its own sidecar. A server started by the GUI is therefore reachable by other local clients with the home token, and a server started elsewhere shows up in the GUI with all of its sessions.

If you bind the server to a non-loopback address (`--host`), also set the `KIKI_PASSWORD` environment variable as a parallel credential; the server then rate-limits authentication failures automatically.

::: danger
`--dangerous-bypass-auth` disables authentication entirely — anyone who can reach the port can control your sessions, file system, and shell. Only use it on trusted networks or behind your own authenticating proxy. See the [kiki command reference](../reference/command.md#kiki-web).
:::

## Change a Codex MCP binding model

The Codex/Kiki external-delegation installer creates a signed runtime directory. If you change its model settings by hand, the HMAC (a tamper-detection signature) no longer matches. Use the installed `kiki-mcp.ps1` launcher to inspect and re-sign the runtime and workspace bindings instead of deleting the delegated session.

```powershell
$runtime = '<runtime-dir>'
$launcher = Join-Path $runtime 'kiki-mcp.ps1'

# Show the runtime defaults, each workspace key, model, effort, and signature state.
& $launcher -RuntimeDir $runtime -ListBindings

# Change one existing workspace binding and the defaults used by new workspaces.
& $launcher -RuntimeDir $runtime -ResignBinding '<workspace-key>' `
  -Model 'kimi-code/kimi-for-coding' -ThinkingEffort 'high'

# Apply the new model parameters to every existing binding too.
& $launcher -RuntimeDir $runtime -ResignAllBindings `
  -Model 'kimi-code/kimi-for-coding' -ThinkingEffort 'high'
```

`-ListBindings` still works when `runtime.json` has a stale signature, so it can diagnose a manual model edit. Re-signing validates the fixed installation fields and artifact hashes, uses the current Windows user's DPAPI-protected signing keys, and stops any affected recorded workspace KAP before rewriting its binding. On the next MCP launch, KAP applies the newly signed model and thinking effort to the persisted delegated session. A targeted re-sign leaves other existing workspace bindings on their current signed models; `-ResignAllBindings` updates all of them.

When a Codex MCP tool call supplies an MCP `progressToken`, delegation dispatch and continuation calls stay open and emit `notifications/progress` updates for turn start, completed tool-call count, and terminal status; clients without a token keep the existing `kiki_status` / `kiki_events` polling behavior.

## Drive a session over the API

The minimal flow with curl: check the server → create a session → subscribe to events → submit a prompt → read history back. The examples assume the server runs at the default address and the token is stored in the shell variable `TOKEN`.

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
