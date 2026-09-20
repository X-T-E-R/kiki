# Node.js SDK

Kiki 目前没有发布到公共 npm registry 的 SDK。要把 Kiki 集成进自己的应用，使用以下受支持的协议入口：

| 集成方式 | 适用场景 | 参考 |
| --- | --- | --- |
| REST + WebSocket API | 脚本、后端服务、自定义客户端——创建会话、提交提示词、订阅实时事件 | [本地服务与 API](./local-server.md)、[服务 API](./rest-api.md) |
| MCP | 让外部工具与 Agent 调用 Kiki | [Model Context Protocol](./mcp.md) |
| ACP | 编辑器与 IDE 客户端 | [ACP](./acp.md) |

Kiki 仓库内还有一个 TypeScript 客户端（`@kiki/klient`，标记为 `private` 的包），供在 monorepo 内开发与贡献时使用；它形成公共发行契约后，本页会更新为完整的 SDK 文档。
