# Node.js SDK

Kiki ships a public TypeScript SDK (`packages/node-sdk` in the repository) that hosts setup and SDK utilities for embedding Kiki's engine in your own tooling. It is the same package the CLI uses for host setup and for the non-interactive `-p` path.

The SDK is a package-level contract, not yet a documented user-facing surface on this site: the public API is owned by the package's types and exports, and this page does not enumerate them. For the supported integration surfaces today, use:

- **REST / WebSocket** — drive sessions over the local server's API; see [Server API](./rest-api.md) and the local-server walkthrough in [Local server and API](./local-server.md).
- **Klient facade** — the contract-driven client over the engine (`global.*` / `session(id).*` / `agent(id).*`), exposed over `http`, `ipc`, and `memory` transports; the routes and semantics it consumes are documented in [Server API](./rest-api.md) and [Kiki runtime boundary](./architecture.md#separate-the-gui-server-and-clients).
- **MCP** — let external tools call Kiki; see [Model Context Protocol](./mcp.md).

::: info
Detailed SDK usage documentation is pending. Until then, treat the package's exported types as the source of truth and rely on the REST/WebSocket reference for wire-level behavior.
:::
