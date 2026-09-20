---
title: Klient TypeScript client (monorepo-internal)
description: Facade structure and three transports of the private @kiki/klient packages; public integrations use the REST/WebSocket, MCP, and ACP docs under server/.
outline: [2, 3]
---

# Klient TypeScript client

`@kiki/klient` is the TypeScript client for Kiki's local server API (the http transport speaks REST + WebSocket), with additional ipc and in-process memory transports. The packages are marked `private`, are not published to a public npm registry, and are used as workspace dependencies inside the monorepo only; this document is the repository-internal development reference. Public integration surfaces are documented in [Server API](../en/server/rest-api.md), [Model Context Protocol](../en/server/mcp.md), and [ACP](../en/server/acp.md).

`@kiki/klient` wraps the engine behind a contract-driven facade (a single unified client object) organized in three tiers: `klient.global.*` manages sessions and global resources, `klient.session(id).*` operates one session, and `session.agent(id).*` drives the Agents inside it. Every method carries a zod-validated input/output contract; you pick the transport once at creation, and the calling code is identical afterwards.

::: info Note
Per-item SDK API documentation is still pending. Until then, treat the package's exported types as the source of truth and rely on the [Server API](../en/server/rest-api.md) reference for wire-level behavior.
:::

## Transports

| Entry | Options | When to use |
| --- | --- | --- |
| `@kiki/klient/http` | `{ endpoint, token? }` | Connect to a running Kiki local server (`kiki web`): REST calls go over HTTP and events over an authenticated WebSocket. Best for scripts, backend services, and IDE integrations |
| `@kiki/klient/ipc` | `{ socketPath, token? }` | Connect to a host process over a local socket (the host serves it via `serveKlientIpc`). Best for inter-process integration on the same machine |
| `@kiki/klient/memory` | `{ scope }` | Pass a bootstrapped engine app scope and drive the engine directly in-process — no server needed. Best for tests and embedding |

All three transports share the same method contracts and JSON frame codec, with identical event semantics.

## Minimal example

Start the local server with `kiki web` and take its token (see [Local server and API](../en/server/local-server.md)), then create a session, subscribe to streaming output, and submit a prompt:

```ts
import { createKlient } from '@kiki/klient/http';

const klient = createKlient({
  endpoint: 'http://127.0.0.1:58627',
  token: '<bearer-token>', // the token printed in the startup banner, same as ~/.kiki/server.token
});

const session = await klient.global.sessions.create({ workDir: process.cwd() });
const agent = klient.session(session.id).agent('main');

// Subscribe before triggering work; await ready before you need to capture output
const output = agent.events.on('assistant.delta', (e) => process.stdout.write(e.delta));
await output.ready;

const receipt = await agent.prompt(
  { input: [{ type: 'text', text: 'Say OK.' }] },
  { waitFor: 'terminal' },
);
console.log(receipt.state);

await klient.session(session.id).close();
await klient.close();
```

`agent.prompt(..., { waitFor: 'terminal' })` waits for that submitted prompt's own terminal receipt (including blocked or failed launches); without `waitFor`, the call returns the launch result immediately. Use `agent.cancel()` to stop execution — it cancels the work without affecting the wait.

To drive the engine directly in-process without a separate server, use the memory transport:

```ts
import { bootstrap, ISessionIndex, logSeed, resolveLoggingConfig } from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/memory';

const homeDir = '/absolute/path/to/kiki-home'; // the engine's data directory
const { app } = bootstrap(
  {
    homeDir,
    clientIdentity: { productName: 'example-client', version: '1.0.0', platform: process.platform },
  },
  [...logSeed(resolveLoggingConfig({ homeDir, env: process.env }))],
);
const klient = createKlient({ scope: app });
await app.accessor.get(ISessionIndex).prepare();

// Session and agent calls from here on are identical to the http transport
```

## Next steps

- [Server API](../en/server/rest-api.md) — protocol reference for the routes and WebSocket events Klient consumes
- [Local server and API](../en/server/local-server.md) — server startup, authentication, and the end-to-end calling flow
- [Model Context Protocol](../en/server/mcp.md) — the reverse integration: let external tools call Kiki
