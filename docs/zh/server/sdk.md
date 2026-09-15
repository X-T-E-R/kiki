# Node.js SDK

Kiki 随附公开的 TypeScript SDK（仓库中的 `packages/node-sdk`），承载宿主设置与 SDK 工具，用于把 Kiki 的引擎嵌入你自己的工具链。CLI 也使用同一个包完成宿主设置和非交互 `-p` 路径。

SDK 是包级契约，尚未在本站形成成体系的用户文档：公开 API 由包的类型与导出承载，本页不逐项列举。当前已支持的使用方式：

- **REST / WebSocket** —— 通过本地服务器的 API 驱动会话；见 [服务 API](./rest-api.md) 与本地服务器端到端示例 [本地服务与 API](./local-server.md)。
- **Klient 门面** —— 覆盖引擎的契约驱动客户端（`global.*` / `session(id).*` / `agent(id).*`），通过 `http`、`ipc`、`memory` 三种传输暴露；它消费的路由与语义见 [服务 API](./rest-api.md) 与 [Kiki 运行时边界](./architecture.md#separate-the-gui-server-and-clients)。
- **MCP** —— 让外部工具调用 Kiki；见 [Model Context Protocol](./mcp.md)。

::: info
SDK 的详细使用文档待补。在此之前，请以包的导出类型为事实来源，并用 REST/WebSocket 参考确认线上行为。
:::
