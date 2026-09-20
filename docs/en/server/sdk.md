# Node.js SDK

Kiki does not currently publish an SDK to a public npm registry. To integrate Kiki into your own application, use one of these supported protocol surfaces:

| Surface | When to use | Reference |
| --- | --- | --- |
| REST + WebSocket API | Scripts, backend services, custom clients — create sessions, submit prompts, subscribe to live events | [Local server and API](./local-server.md), [Server API](./rest-api.md) |
| MCP | Let external tools and agents call Kiki | [Model Context Protocol](./mcp.md) |
| ACP | Editor and IDE clients | [ACP](./acp.md) |

The Kiki repository also contains a TypeScript client (`@kiki/klient`, marked as a `private` package) for development and contributions inside the monorepo; this page will grow into full SDK documentation once it forms a public release contract.
