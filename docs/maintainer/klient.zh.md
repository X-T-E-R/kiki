---
title: Klient TypeScript 客户端（monorepo 内部）
description: 私有包 @kiki/klient 的门面结构与三种传输；公开集成请走 server/ 文档的 REST/WebSocket、MCP、ACP。
outline: [2, 3]
---

# Klient TypeScript 客户端

`@kiki/klient` 是 Kiki 本地服务 API 的 TypeScript 客户端（http 传输走 REST + WebSocket 协议），同时提供 ipc 与 memory 两种进程内传输。包标记为 `private`，未发布到公共 npm registry，只在 monorepo 内以 workspace 依赖使用；本文是仓库内部的开发参考，公开集成入口见 [服务 API](../zh/server/rest-api.md)、[Model Context Protocol](../zh/server/mcp.md) 与 [ACP](../zh/server/acp.md)。

`@kiki/klient` 把引擎能力封装成一个契约驱动的门面（facade，统一的客户端对象），按三个层级组织：`klient.global.*` 管理会话与全局资源，`klient.session(id).*` 操作单个会话，`session.agent(id).*` 驱动会话内的 Agent。每个方法都有经 zod 校验的输入输出契约；传输方式在创建客户端时选择一次，之后的调用代码与所选传输无关。

::: info 说明
SDK 的逐项 API 文档待补。在此之前，请以包导出的类型为事实来源，并用 [服务 API](../zh/server/rest-api.md) 确认线上行为。
:::

## 三种传输

| 入口 | 创建参数 | 适用场景 |
| --- | --- | --- |
| `@kiki/klient/http` | `{ endpoint, token? }` | 连接运行中的 Kiki 本地服务（`kiki web`）：REST 调用走 HTTP，事件走已鉴权的 WebSocket。适合脚本、后端服务与 IDE 集成 |
| `@kiki/klient/ipc` | `{ socketPath, token? }` | 通过本机 socket 连接宿主进程（宿主用 `serveKlientIpc` 提供服务）。适合同一台机器上的进程间集成 |
| `@kiki/klient/memory` | `{ scope }` | 传入一个已启动的引擎 app scope，在进程内直接驱动引擎，不需要任何服务器。适合测试与嵌入式使用 |

三种传输使用同一套方法契约和 JSON 帧编解码，事件语义一致。

## 最小示例

先用 `kiki web` 启动本地服务并拿到 token（见[本地服务与 API](../zh/server/local-server.md)），然后创建会话、订阅流式输出并发送一条提示词：

```ts
import { createKlient } from '@kiki/klient/http';

const klient = createKlient({
  endpoint: 'http://127.0.0.1:58627',
  token: '<bearer-token>', // 启动横幅打印的 token，与 ~/.kiki/server.token 一致
});

const session = await klient.global.sessions.create({ workDir: process.cwd() });
const agent = klient.session(session.id).agent('main');

// 先订阅、再触发工作；等待 ready 后才开始捕获输出
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

`agent.prompt(..., { waitFor: 'terminal' })` 等待这条提示词自己的终止回执（包括启动失败或被拦截的情况）；不带 `waitFor` 时调用立即返回启动结果。需要中止执行时用 `agent.cancel()`，它只取消执行，不影响这次等待。

不需要独立服务器、想在进程内直接驱动引擎时，改用 memory 传输：

```ts
import { bootstrap, ISessionIndex, logSeed, resolveLoggingConfig } from '@kiki/agent-core-v2';
import { createKlient } from '@kiki/klient/memory';

const homeDir = '/absolute/path/to/kiki-home'; // 引擎的数据目录
const { app } = bootstrap(
  {
    homeDir,
    clientIdentity: { productName: 'example-client', version: '1.0.0', platform: process.platform },
  },
  [...logSeed(resolveLoggingConfig({ homeDir, env: process.env }))],
);
const klient = createKlient({ scope: app });
await app.accessor.get(ISessionIndex).prepare();

// 之后的会话与 Agent 调用与 http 传输完全一致
```

## 下一步

- [服务 API](../zh/server/rest-api.md) — Klient 所消费的路由与 WebSocket 事件的协议参考
- [本地服务与 API](../zh/server/local-server.md) — 服务的启动、鉴权与端到端调用流程
- [Model Context Protocol](../zh/server/mcp.md) — 反方向集成：让外部工具调用 Kiki
