# Kiki 运行时边界

`kiki` 是产品的 CLI 入口，负责启动 daemon 支持的终端界面、运行非交互 `-p` 请求，并提供 daemon、席位和 MCP 集成命令。安装包不会再安装第二个 `kimi` 可执行文件。启动与迁移方式见[命令参考](../zh/reference/command.md)。

本指南区分继承的实现与 Kiki 自有的集成。包名或源码检查通过，不代表对应 npm 包或桌面版本已经发布。

## 理解边界

以下分类描述来源与维护责任，不表示发布就绪：

- **继承**：实现或契约来自上游 Kimi Code 基线。
- **改造**：Kiki 修改了继承子系统的集成方式或支持行为。
- **Kiki 独有**：在分叉点之后新增，在该比较时点没有对应的上游表面。

| 表面 | 分类 | 当前边界 |
| --- | --- | --- |
| CLI、TUI（终端用户界面）和可执行文件身份 | 改造 | 命令为 `kiki`；交互会话连接共享 daemon，不再创建独立的终端运行时。 |
| `kap-server`、`@kiki/protocol` 和引擎的会话、配置、认证契约 | 继承与改造 | 既有服务端契约仍在使用；Kiki 增加统一客户端接线，不另建一个引擎。 |
| `agent-core-v2` 的模型绑定区域 | 改造 | Kiki 负责下游模型/effort 绑定与派遣集成。 |
| 子 Agent 的显式模型别名和 thinking effort | Kiki 独有 | 工具参数使用 `model_alias` 和 `effort`；Agent 文件使用 `thinking_effort`。 |
| 按模型进行[提示词调节](../zh/configuration/config-files.md#模型认知) | Kiki 独有 | Overlay、steering 和 anchor 文件挂在模型别名上；未声明的字段不附带或注入默认正文。 |
| `AgentRun`、`AgentList` 和 `AgentSend` | Kiki 独有 | 直属子 Agent 的启动/继续、发现与邮箱操作。 |
| 本地 peer thread 通信 | Kiki 独有 | Agent 可以协调本机会话；外部 REST/Klient 调用方只能指定消息目标，不能声明 peer 归属。 |
| `@kiki/gui` 与共享 `@kiki/session-core` 客户端集成 | Kiki 独有与改造 | GUI 和终端会话视图消费共享客户端契约；改造自其他项目的 GUI 内容保留其具体来源标注。 |

比较锚点为 `437a1b8`，不表示之后的全部上游变更都已存在。

## 选择命令和运行时

所有表面使用 `agent-core-v2`；历史 v1 引擎不是可选运行时。

| 调用方式 | 运行时行为 |
| --- | --- |
| `kiki` | 连接或启动共享 daemon，再打开 TUI。启动失败会明确报告，不回退到旧的本地 TUI。 |
| `kiki -p "提示词"` | 通过共享 Klient 接口运行 SDK 托管的内存引擎，不打开 TUI，也不连接 daemon。等待本次提示词的终态结果，再执行配置中的后台任务处理策略。 |
| `kiki serve --ensure --workspace . --json` | 复用健康的共享 daemon，或启动一个新实例。 |
| `kiki serve --stop` | 通过受支持的生命周期命令停止共享 daemon。 |
| `kiki web` | 兼容的前台 REST/WebSocket/web UI 命令，不连接已有共享 daemon。 |
| `@kiki/gui` | 共享引擎和服务端的浏览器/桌面客户端；GUI workspace 包不安装另一套 CLI。 |

`KIKI_EXPERIMENTAL_FLAG=1` 启用已注册的实验功能，不是引擎或产品选择器。详见[环境变量](../zh/configuration/env-vars.md#运行时开关)。

## 启用 Kiki 独有的 Agent 功能

显式模型与 effort 绑定、直属子 Agent 工具和实验功能选择是不同的能力。需要某项实验时使用该功能自己的开关；总开关会启用全部已注册实验，范围大于单项选择。

[Agent 与子 Agent](../zh/customization/agents.md)说明绑定优先级和生命周期；[配置文件](../zh/configuration/config-files.md#subagent)说明子 Agent 超时与黑名单设置。

## 集成 peer thread 通信

Peer thread 通信默认关闭，通过 [`[thread_communication] enabled = true`](../zh/configuration/config-files.md#thread-communication) 启用。引用包含主机、工作区和会话身份，跨主机发送会被拒绝。只有主 Agent 接收 4 个内置 thread 工具。向冷会话发送消息可能恢复该会话并消耗模型额度。

服务端在 `/api` 下提供这些路由：

| 操作 | 路由 |
| --- | --- |
| 列出 thread | `GET /api/threads` |
| 读取已完成 turn | `POST /api/threads:read` |
| 发送消息 | `POST /api/threads:send` |
| 等待活动 | `POST /api/threads:wait` |
| 读取工作区覆盖值 | `GET /api/workspaces/{workspace_id}/thread-communication` |
| 设置工作区覆盖值 | `PUT /api/workspaces/{workspace_id}/thread-communication` |
| 清除工作区覆盖值 | `DELETE /api/workspaces/{workspace_id}/thread-communication` |

`POST /api/threads:send` 接受 `target`、`content` 和 `idempotency_key`，拒绝 `source`，并记为 user 来源输入。Schema 见 `GET /openapi.json`；`GET /api/meta` 通过 `capabilities.thread_communication: true` 声明支持。

Klient 提供 `global.threads.hostId`、`list`、`read`、`send`、`wait`、`getWorkspaceOverride`、`setWorkspaceOverride`、`clearWorkspaceOverride` 和 `isWorkspaceEnabled`。发送时使用 `global.threads.send({ target, content, idempotencyKey })`。底层传输附加的字段不能生成 peer 归属；真实 peer 发送须使用来源 Agent 的 `ThreadSend` 工具，由工具派生来源身份。

工作区覆盖值会跨重启保留。清除后恢复全局设置；启用的覆盖值也不能绕过已关闭的全局配置节。

## 区分 GUI、服务端和客户端

GUI 和 TUI 会话视图通过共享 session-core 集成消费 Klient 的会话视图/命令契约，daemon 负责引擎执行。既有通用 REST 路由、终端/全局 WebSocket 流量及非交互 SDK 链路仍然存在；统一会话接线不表示所有历史传输或 SDK 入口都已删除。

Kiki 维护者负责下游 CLI 身份、客户端集成、home 解析和迁移契约。上游是继承实现的来源，不是恢复旧可执行文件或第二套实时 home 的指令。

`apps/kiki-gui/ATTRIBUTION.md` 记录了改造自 codeg、AionUi、grok-build 和 LiveAgent 的内容，按具体行为标明来源并列出已知许可证；它不把单个来源许可证归给整个目标文件，也不表示已完成全部分发声明。

## 使用唯一运行时 home

运行时配置、会话和 OAuth 凭据使用 `KIKI_HOME`，默认 `~/.kiki`。支持显式 `--home` 的命令优先使用该选项。旧 `KIMI_CODE_HOME` 设置不是启动回退项。真实 Kimi provider/OAuth 身份与端点保持不变；产品 home 改名不等于改供应商协议。

桌面的兼容 home 设置只选择迁移来源。登录、退出登录和 token 刷新不再作用于单独选择的旧 home。依赖旧凭据前，请执行[显式配置迁移](../zh/reference/command.md#kiki-migrate-config)或重新登录。

`kiki migrate-config` 复制受支持的配置、凭据、设备身份和自定义资源，不覆盖已有 Kiki 文件，也不删除来源。`--workspace <目录>` 将项目 `local.toml`、`AGENTS.md`、`mcp.json` 和自定义资源树迁到 `.kiki`。根 `AGENTS.md` 与标准 `.mcp.json` 留在原处并保持既有语义。项目本地 MCP 仍针对选定的当前工作目录，不会隐式合并所有祖先目录中的产品 MCP 文件。

桌面的独立模型类别导入只复制 `providers`、`models`、`services`、`default_model`、`default_provider` 和 `thinking`。Map 类别按 key 合并，同名别名由来源覆盖，未涉及的类别与注释不变。该操作不复制凭据；导入的认证引用可能需要完整迁移或重新登录。重复导入不变内容会返回无变更。无界面使用时，先停止自有后端，再从 `apps/kiki-gui` 运行：

```sh
pnpm desktop:import-kimi-config --source-home <绝对路径> --target-home <绝对路径>
```

该命令只报告状态、路径和类别名称，不复制 OAuth、会话或技能。桌面的会话移动与技能复制仍是独立操作：会话移动转移 `workspaces.json` 和 `sessions/`，部分失败时执行补偿；技能复制保留来源和已占用的目标。这些操作只停止/重启 Kiki 自有后端，不影响外部 Kimi Code 进程。迁移外部进程的数据前请先关闭它们。

## 从上游同步

上游基线为 `MoonshotAI/kimi-code`，Kiki 自有仓库为 `X-T-E-R/kiki`。同步需要明确审查和选择性移植，不会因产品名称或功能开关自动发生。

1. 根据当前 Kiki 契约评估继承实现的修复，不恢复已退役的入口或 home fallback。
2. 在对应的引擎/服务端边界集成已接受变更。
3. 用定向回归检查保护 Kiki 自有的派遣和客户端行为。
4. 改造内容或实际分发依赖图变化时，重新检查来源归属。

## 源码索引

- **命令与 daemon 启动**：`apps/kimi-code/src/cli/commands.ts`、`apps/kimi-code/src/kiki/`、`apps/kimi-code/package.json`
- **服务端与客户端契约**：`packages/kap-server/`、`packages/protocol/`、`packages/klient/`、`packages/session-core/`
- **SDK 执行**：`packages/node-sdk/`
- **Home 解析与显式迁移**：`packages/oauth/src/home.ts`
- **模型/effort 绑定与子 Agent 执行**：`packages/agent-core-v2/src/session/subagent/`、`packages/agent-core-v2/src/session/dispatch/`
- **提示词调节**：`packages/agent-core-v2/src/agent/cognition/`、`packages/agent-core-v2/src/features/modelSteering/`、`packages/agent-core-v2/src/app/kosongConfig/configSection.ts`
- **Peer thread**：`packages/agent-core-v2/src/app/threadCommunication/`、`packages/kap-server/src/routes/threads.ts`、`packages/klient/src/contract/global/threads.ts`
- **GUI 来源归属**：`apps/kiki-gui/ATTRIBUTION.md`

## 下一步

- [开始使用](../zh/getting-started/first-launch.md) — 选择发行包或本地源码构建。
- [Agent 与子 Agent](../zh/customization/agents.md) — 配置绑定与子 Agent 工具。
- [环境变量](../zh/configuration/env-vars.md#运行时开关) — 设置运行时选项和实验功能。
- [`kiki` 命令参考](../zh/reference/command.md) — daemon、inbound 集成与显式迁移。
