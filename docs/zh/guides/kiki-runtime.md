# Kiki 运行时边界

使用终端或终端界面时，运行的命令仍是 `kimi`。**Kiki** 指这个仓库中的下游新增内容；它不是另一个可执行文件，也不取代现有的 Kimi Code CLI 文档。

本指南说明哪些运行时表面继承自上游 Kimi Code 基线、哪些区域由 Kiki 改造，以及哪些功能只存在于 Kiki。配置功能、报告回归问题或处理上游同步冲突前，先用这套分类确认边界。

## 理解边界

分类描述功能的来源和维护边界，不代表质量或发布状态：

- **继承**：公开行为或契约来自上游 Kimi Code 基线，现有文档仍是默认参考。
- **改造**：主要契约仍由上游子系统提供，但 Kiki 修改了其中明确的集成区域。
- **Kiki 独有**：package、工具或行为是在 Kiki fork point（作为比较起点的上游 commit）之后新增的，在该时间点没有对应的上游 Kimi Code 基线。

| 表面 | 分类 | 此处分类的含义 |
| --- | --- | --- |
| Kimi Code CLI、TUI（终端用户界面）和 `kimi` 命令 | 继承 | 安装、登录、会话、配置和常规命令行为继续使用现有的 Kimi Code CLI 文档。 |
| `kap-server`、`@moonshot-ai/protocol`，以及它们提供的会话、配置和认证契约 | 继承 | Kiki 客户端使用这些契约，不另行定义一套服务端或协议。 |
| `agent-core-v2` 中的模型绑定区域 | 改造 | Kiki 扩展了选定的上游 Agent 引擎路径，同时保留原有的会话和任务生命周期。 |
| 为新派生子 Agent 显式绑定模型 alias 和 thinking effort | Kiki 独有 | 只有符号选择器路径默认关闭，显式绑定本身是稳定能力，始终可用。工具参数用 `model_alias` 和 `effort`；Agent 文件仍用 `thinking_effort`。 |
| 通过 [`[models."<alias>".cognition]`](../configuration/config-files.md#模型认知) 按模型做提示词调节 | Kiki 独有 | Overlay、steering 和 anchor 提示词文件挂到模型别名上，而不是 Agent profile 上。仓库不为它们附带任何默认正文；每个文件都在运行时从数据根读取，未声明的字段不会注入任何内容。 |
| 直属子 Agent 工具 `AgentRun`、`AgentSwarm`、`AgentList` 和 `AgentSend` | Kiki 独有 | 始终出现在主 `agent` profile 上，用于启动或继续子 Agent、按 item 并行派发、列出直属子 Agent，以及向邮箱排队消息。 |
| 本地 peer thread 通信 | Kiki 独有 | 主 Agent 可以跨本地工作区列出、读取、发送消息并等待现有会话；REST 和 Klient 只允许外部客户端指定目标，发送结果不带 peer 归属。 |
| 独立的 `@kiki/gui` package | Kiki 独有 | GUI 是继承服务端和协议表面的下游客户端。部分组件改造自已单独标注来源的其他开源项目，因此这些组件在 Kiki 独有 package 内归类为改造。 |

本指南使用的仓库 fork point 是 `437a1b8`。这个提交哈希只作为比较锚点，不表示此后的上游变更已经存在于当前仓库中。

## 选择命令和运行时

所有表面都跑同一个引擎 `agent-core-v2`。没有引擎选择开关：本 fork 已移除历史上的 v1 引擎，`KIMI_CODE_LEGACY_FLAG` 随之消失。

| 调用方式或设置 | 运行时行为 |
| --- | --- |
| `kimi` 或 `kimi -p` | 在 `agent-core-v2` 上使用继承的 CLI/TUI 表面。 |
| `kimi web` | 启动 `kap-server`，同样跑在 `agent-core-v2` 上。 |
| `@kiki/gui` | 作为独立的私有 workspace package 存在，并以客户端身份连接服务端。它不会安装 `kiki` 命令，也不取代 TUI。 |

`KIMI_CODE_EXPERIMENTAL_FLAG=1` 会在 Agent 引擎内启用已注册的实验功能。它不会把可执行文件变成 Kiki。完整开关见[环境变量](../configuration/env-vars.md#运行时开关)，命令语法见 [`kimi` 命令参考](../reference/kimi-command.md)。

## 启用 Kiki 独有的 Agent 功能

下面的模型选择器仍属于实验功能，默认关闭。

| 功能 | 启用方式 | 额外边界 |
| --- | --- | --- |
| 所有已注册的实验功能 | `KIMI_CODE_EXPERIMENTAL_FLAG=1` | 这是宽范围的总开关，不是运行时或产品选择器。 |

[Agent 与子 Agent](../customization/agents.md)说明绑定优先级、生命周期和子 Agent 工具；[配置文件](../configuration/config-files.md#subagent)说明 `[subagent]` 的超时与黑名单。

## 集成 peer thread 通信

Peer thread 通信默认关闭。设置 [`[thread_communication] enabled = true`](../configuration/config-files.md#thread-communication) 后才会启用。启用后，它可以协调本机上的现有会话，也可以跨工作区；每条 thread 引用都包含主机、工作区和会话身份，跨主机发送会被拒绝。只有主 Agent 能使用 4 个内置 thread 工具，本地客户端也可以直接调用同一套契约。向冷会话发送消息可能会恢复该会话并消耗模型额度。

下方的 REST/Klient 接口由 `kimi web` 提供。

Kimi 服务运行后，以下 REST 接口位于 `/api/v1` 下：

| 操作 | 路由 |
| --- | --- |
| 列出 thread | `GET /api/v1/threads` |
| 读取已完成 turn | `POST /api/v1/threads:read` |
| 发送消息 | `POST /api/v1/threads:send` |
| 等待活动 | `POST /api/v1/threads:wait` |
| 读取工作区覆盖值 | `GET /api/v1/workspaces/{workspace_id}/thread-communication` |
| 设置工作区覆盖值 | `PUT /api/v1/workspaces/{workspace_id}/thread-communication` |
| 清除工作区覆盖值 | `DELETE /api/v1/workspaces/{workspace_id}/thread-communication` |

`POST /api/v1/threads:send` 只接受 `target`、`content` 和 `idempotency_key`。旧的 `source` 字段会被拒绝，投递后的 turn 记为 user 来源输入；REST 客户端不能自行声明来源 thread。完整请求与响应 schema 见 `GET /openapi.json`。`GET /api/v1/meta` 通过 `capabilities.thread_communication: true` 表明服务端支持该功能。

Klient 在 `global.threads` 下提供对应方法：`hostId`、`list`、`read`、`send`、`wait`、`getWorkspaceOverride`、`setWorkspaceOverride`、`clearWorkspaceOverride` 和 `isWorkspaceEnabled`。发送时调用 `global.threads.send({ target, content, idempotencyKey })`。

这个严格 facade 不接受 `source`，通过底层传输附加来源数据也不能生成 peer 归属。与 REST 相同，Klient 发送会记为 user 来源输入。如需记录真实的 peer 归属，来源会话的主 Agent 必须调用 `send_message_to_thread`，由工具根据当前会话派生来源，而不是使用客户端提交的数据。

工作区覆盖值会跨重启保留。清除覆盖值后，该工作区重新使用全局设置；即使覆盖值为启用，也不能绕过已关闭的全局 `[thread_communication]` 配置节。

## 区分 GUI、服务端和客户端

Kiki 没有引入第二套后端。`@kiki/gui` 调用继承的 `kap-server` REST 和 WebSocket 表面（用于请求/响应的 API 与实时更新通道），并使用 `@moonshot-ai/protocol` 中的类型；现有 TUI 和其他客户端继续使用各自既有的 Kimi Code 路径。

| 边界 | 本仓库中的责任方 | 影响 |
| --- | --- | --- |
| CLI/TUI 命令表面 | 上游 Kimi Code 基线 | 继续把 `kimi` 行为和现有用户文档作为默认契约。 |
| 服务端、协议、会话、配置和认证表面 | 上游 Kimi Code 基线 | 除非有意重新分类契约本身，否则 Kiki 客户端改动应适配这套契约。 |
| Agent 引擎集成改动 | Kiki 维护者 | Kiki 负责下游改动引入的模型/effort 绑定与子 Agent 工具回归问题。 |
| `@kiki/gui` 客户端、状态和呈现 | Kiki 维护者 | 该 package 是仓库中的私有 workspace 表面；它的存在不表示公开发布或生产就绪。 |

GUI package 在 `apps/kiki-gui/ATTRIBUTION.md` 中记录了改造自 codeg、AionUi、grok-build 和 LiveAgent 的内容。该文件把来源归到具体的改造行为，并列出已知依赖的许可证；它明确不把来源项目的许可证直接归给整个目标文件，也不表示已经形成完整的分发声明。

## 分离 Kiki 数据与 Kimi OAuth

桌面应用把 Kiki 自有数据保存在 `KIKI_HOME`（默认 `~/.kiki`）下。配置路径始终是 `KIKI_HOME/config.toml`；选择 Kimi Home 不会用 Kimi Code 的完整配置替换该文件。

Kimi OAuth 则有意共享。所选 Kimi Home 可以是 Kimi Code 默认 Home，也可以是自定义绝对路径；Kiki 的登录、退出登录和刷新会直接使用 `<Kimi Home>/credentials/kimi-code.json`、`<Kimi Home>/device_id` 和 `<Kimi Home>/oauth/`。因此这些操作会影响同一份 Kimi Code 登录状态；Kiki 不会把 OAuth 凭据复制到 `KIKI_HOME`。

Settings 卡片提供可重复执行的单向模型配置导入，来源是所选 Kimi Home。导入范围只包括 `providers`、`models`、`services`、`default_model`、`default_provider` 和 `thinking`。前三个 map 类别按 key 合并：同名 alias 由来源覆盖，Kiki 独有 alias 保留；其余类别只在来源存在时替换 Kiki 值。OAuth 凭据文件不会被复制；导入的提供商与服务配置可以继续引用所选 Kimi Home 中已经共享的凭据。所有其他 Kiki 配置节以及未被覆盖条目上的注释保持不变，重复导入同一内容会返回 noop。桌面操作只停止并重启 Kiki 自有后端。使用 headless 维护入口前应先停止该后端，然后在 `apps/kiki-gui` 中运行：

```sh
pnpm desktop:import-kimi-config
```

可传入 `--source-home <绝对路径>` 和 `--target-home <绝对路径>` 覆盖默认 Home。该命令只输出状态、路径和类别名称，不读取或移动 OAuth、会话或技能。

会话和用户技能只把所选 Kimi Home 当作迁移来源。移动会话时，Kiki 会停止自有后端、重新计算计划，然后只重命名 `workspaces.json` 和 `sessions/`；如果目录重命名在目录已移动后失败，Kiki 会立即反向重命名目录，补偿也失败时则报告部分移动错误。复制用户技能会保留来源，也不会覆盖已有的 Kiki 目标。复制类迁移只停止并重启 Kiki 自有后端，不会停止或锁定外部 Kimi Code 进程，因此迁移前建议关闭这些进程。

## 从上游同步

当前配置的 upstream 是 `MoonshotAI/kimi-code`，本指南以 `437a1b8` 为比较锚点。上游同步是一项需要明确执行的 Git 与集成操作；Kiki 名称、功能开关或 GUI 都不会自动导入后续上游变更。

检查上游更新时，按下面的顺序处理：

1. 让继承的命令、服务端、协议、会话、配置和认证契约跟随上游变更。
2. 在集成接缝处重新应用或修复改造过的 Agent 引擎改动，不要把整个引擎视为 Kiki 独有。
3. 只在 Kiki 独有行为仍能与更新后的继承契约组合时保留该行为。
4. 改造自其他开源项目的内容或实际分发的依赖图发生变化时，重新检查 GUI 来源归属。

这个顺序能把上游修复和下游行为区分开，并在回归问题跨越边界时明确责任方。

## 源码索引

以下仓库路径是本指南分类的依据：

- **命令表面**：`apps/kimi-code/package.json`
- **继承的服务端和协议**：`packages/kap-server/`、`packages/protocol/`、`packages/node-sdk/` 和 `packages/oauth/`
- **改造过的模型绑定区域**：`packages/agent-core-v2/src/session/subagent/`
- **Kiki 独有的按模型提示词调节**：`packages/agent-core-v2/src/agent/cognition/`、`packages/agent-core-v2/src/features/modelSteering/` 以及 `packages/agent-core-v2/src/app/kosongConfig/configSection.ts` 中的 `cognition` schema
- **Kiki 独有的子 Agent 工具**：`packages/agent-core-v2/src/agent/tools/agent/`、`packages/agent-core-v2/src/agent/tools/agent-list/` 和 `packages/agent-core-v2/src/agent/tools/agent-send/`
- **Kiki 独有的 peer thread 核心与传输层**：`packages/agent-core-v2/src/app/threadCommunication/`、`packages/kap-server/src/routes/threads.ts` 和 `packages/klient/src/contract/global/threads.ts`
- **Kiki 独有 GUI 及其来源项目边界**：`apps/kiki-gui/package.json`、`apps/kiki-gui/src/lib/client.ts` 和 `apps/kiki-gui/ATTRIBUTION.md`

## 下一步

- [开始使用](./getting-started.md) — 安装并运行继承的 `kimi` 命令。
- [Agent 与子 Agent](../customization/agents.md) — 配置模型绑定，并使用子 Agent 工具。
- [环境变量](../configuration/env-vars.md#运行时开关) — 对比 Agent 引擎选择与实验功能开关。
- [`kimi` 命令参考](../reference/kimi-command.md) — 查询当前可执行文件、flag 和子命令。
