# Node.js SDK

Kiki has no published SDK on npm. To integrate Kiki into your own application, use one of these protocol surfaces:

| Surface | When to use | Reference |
| --- | --- | --- |
| REST + WebSocket API | Scripts, backend services, custom clients — create sessions, submit prompts, subscribe to live events | [Local server and API](./local-server.md), [Server API](./rest-api.md) |
| MCP | Let external tools and agents call Kiki | [Model Context Protocol](./mcp.md) |
| ACP | Editor and IDE clients | [ACP](./acp.md) |

The repository also contains a TypeScript client (`@kiki/klient`) used by Kiki's own tests and tooling. It is not published, so do not depend on it from your own code.
