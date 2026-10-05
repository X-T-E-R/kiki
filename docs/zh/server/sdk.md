# Node.js SDK

Kiki 没有发布到 npm 的 SDK。要把 Kiki 集成进自己的应用，使用以下协议入口：

| 集成方式 | 适用场景 | 参考 |
| --- | --- | --- |
| REST + WebSocket API | 脚本、后端服务、自定义客户端——创建会话、提交提示词、订阅实时事件 | [本地服务与 API](./local-server.md)、[服务 API](./rest-api.md) |
| MCP | 让外部工具与 Agent 调用 Kiki | [Model Context Protocol](./mcp.md) |
| ACP | 编辑器与 IDE 客户端 | [ACP](./acp.md) |

仓库里还有一个 TypeScript 客户端（`@kiki/klient`），Kiki 自己的测试和工具链在用。它没有发布，不要在你自己代码里依赖它。
