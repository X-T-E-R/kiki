# kiki 命令

`kiki` 是产品的统一 CLI 入口（三端产品中面向终端的一端：桌面版、CLI/TUI、服务器），提供 daemon 支持的交互式 TUI、非交互 `-p` 模式和共享 daemon 控制。无参数运行时在工作区信任后连接健康 daemon，不存在则启动；`kiki -p` 继续走独立的 SDK 非交互链路。显式管理 daemon 用 `kiki serve`，需要兼容的前台服务 / UI 时用 `kiki web`。

```sh
kiki [options]
kiki <subcommand> [options]
```

交互式会话始终使用共享后台服务（daemon）。确认工作目录可信后，CLI 会连接已有服务，或自动启动服务，无需单独安装或开启实验开关。连接或启动失败时会显示错误，不会回退到独立的本地会话。请根据错误提示排除问题后重新运行命令。非交互式 `--prompt` 执行不属于这条终端启动链路。

## 主命令选项

所有 flag 都是可选的，直接运行 `kiki` 即可进入交互式会话：

| 选项 | 简写 | 说明 |
| --- | --- | --- |
| `--version` | `-V` | 打印版本号并退出 |
| `--help` | `-h` | 显示帮助信息并退出 |
| `--session [id]` | `-S` | 恢复一个会话。带 ID 时直接打开指定会话；不带 ID 时进入交互式选择器 |
| `--continue` | `-c` | 继续当前工作目录下最近一次的会话，无需手动指定 ID |
| `--model <model>` | `-m` | 为本次启动指定模型别名。省略时新会话使用配置文件中的 `default_model` |
| `--prompt <prompt>` | `-p` | 非交互执行单次 prompt，并把 Assistant 输出流式写到 stdout。该模式不会打开 TUI |
| `--output-format <format>` | | 设置非交互输出格式，支持 `text` 与 `stream-json`。仅可与 `--prompt` 一起使用，默认 `text` |
| `--yolo` | `-y` | 自动批准普通工具调用，跳过审批请求 |
| `--auto` | | 以 auto 权限模式启动；工具审批自动处理，Agent 不会向用户提问 |
| `--plan` | | 以 Plan 模式启动新会话，AI 会优先使用只读工具进行探索和规划 |
| `--skills-dir <dir>` | | 从指定目录加载 Skills，替换自动发现的用户和项目目录。可重复传入 |
| `--agent <name>` | | 以指定 Agent 作为 main agent 启动新会话。不能与 `--session`/`--continue` 同时使用 |
| `--agent-file <path>` | | 从 Markdown 文件加载自定义 Agent 并为新会话选中它。不可重复传入，也不能与 `--agent`、`--session` 或 `--continue` 同时使用 |
| `--add-dir <dir>` | | 为本次会话添加额外的工作目录。相对路径按当前工作目录解析。可重复传入 |

`-r` / `--resume` 是 `--session` 的隐藏别名；`--yes` 和 `--auto-approve` 是 `--yolo` 的隐藏别名，在帮助信息中不显示。

::: warning 注意
`--yolo` 会跳过普通工具调用的人工确认，包括文件写入和 Shell 命令执行，请只在受信任的工作目录下使用。Plan 模式的退出审批不会被 `--yolo` 跳过；Plan 模式下的 `Bash` 按普通放行规则处理。
:::

### flag 冲突规则

以下组合会在启动时被拒绝：

- `--continue` 与 `--session` 互斥——两者都表示"恢复历史会话"
- `--yolo` 和 `--auto` 互斥——两种权限模式互斥
- `--prompt` 不能与 `--yolo`、`--auto` 或 `--plan` 同时使用——非交互模式固定使用 `auto` 权限
- `--output-format` 只能与 `--prompt` 一起使用

恢复会话时，可以通过 `--auto`、`--yolo` 或 `--plan` 覆盖原会话保存的权限或计划模式。例如，`kiki --continue --auto` 会恢复最近会话并切换到 auto 权限模式。

## 典型用法

直接运行开启新会话：

```sh
kiki
```

从上次中断的地方继续（自动找到当前目录最近的会话）：

```sh
kiki --continue
```

从历史会话列表中挑选，或直接指定已知 ID：

```sh
kiki --session
kiki --session 01HZ...XYZ
```

跳过审批确认，适合已知安全的批处理任务：

```sh
kiki --yolo
```

让 Agent 自行处理一切，不再向用户提问：

```sh
kiki --auto
```

先阅读代码、产出实现计划，而不是立刻动手修改文件：

```sh
kiki --plan
```

### 自定义 Skills 目录

有两种方式指定 Skills 目录，语义不同：

- **`--skills-dir <dir>`**（CLI flag）：**替换**自动发现的用户和项目目录，仅对本次启动生效。可重复传入以叠加多个目录：

  ```sh
  kiki --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs`**（`config.toml`）：**叠加**到自动发现的目录之上，长期生效，适合配置团队共享 Skills。详见 [Agent Skills](../customization/skills.md)。

### 自定义 Agent

`--agent` 和 `--agent-file` 用于选择驱动新会话的 Agent，在 print 模式（`kiki -p`）和交互式 TUI 中均可使用：

```sh
kiki --agent reviewer
kiki -p --agent reviewer "审查这个分支上的改动"
```

`--agent-file` 以最高优先级注册单个 Agent 文件（仅本次启动）并选中它；该 flag 不可重复传入，`--agent` 与 `--agent-file` 互斥。两个 flag 都仅在新建会话时有效——都不能与 `--session`/`--continue` 组合，因为 Agent 在会话创建时绑定，恢复会话时会自动还原已绑定的 Agent。选择在会话首次绑定后即固定，之后不可切换；在 TUI 中，这些 flag 只绑定启动时的会话，之后在同一进程内新建的会话（例如通过 `/new`）使用默认 Agent。Agent 文件格式与发现目录详见 [Agent 与 subagent](../customization/agents.md#自定义-agent)。

## 非交互执行

在脚本或 CI 中运行单次 prompt 时，使用 `-p`：

```sh
kiki -p "Summarize the current repository status"
```

输出采用 transcript 样式：thinking 内容和 Assistant 正文都以 `• ` 开头，换行后两个空格缩进。Assistant 正文输出到 stdout；thinking、工具进度和"恢复会话"提示输出到 stderr。`-p` 模式不会请求人工审批，普通工具调用按 `auto` 权限策略处理，静态 deny 规则仍然生效。

临时切换模型：

```sh
kiki -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

需要结构化读取输出时，使用 `stream-json` 格式——stdout 每行都是一个 JSON 对象：

```sh
kiki -p "List changed files" --output-format stream-json
```

`stream-json` 模式下，普通回复输出 Assistant 消息；模型调用工具时，先输出带 `tool_calls` 的 Assistant 消息，再输出对应的 Tool 消息，最后继续输出后续 Assistant 消息。thinking 内容不会写入 JSONL；工具进度和恢复会话提示仍写到 stderr。

## 子命令

`kiki` 提供以下子命令：`serve`（启动、复用或停止共享 daemon）、`seat`（管理外部调用方席位）、`mcp`（运行 stdio MCP 边）、`doctor`（诊断 daemon 连接）、`migrate-config`（显式迁移旧配置和自定义资源）、`login`（非交互式 OAuth 登录）、`acp`（ACP IDE 模式）、`web`（兼容的前台 REST/WebSocket/web 服务）、`export`（导出会话）和 `provider`（管理供应商）。

### `kiki serve`

显式控制共享 daemon。不带模式时，`serve` 在前台运行 daemon；`--ensure` 连接已有健康实例，或启动一个新实例并返回连接信息；`--stop` 停止所选 home 下当前可达的实例。

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

交互式 TUI 在工作区信任后也会自动执行同样的连接或启动逻辑。`--idle-exit` 默认是 `30m`；活跃的客户端 lease 和运行中的派遣会让 daemon 保持运行。需要兼容的前台服务和浏览器 UI，而不是共享 daemon 控制时，请用 [`kiki web`](#kiki-web)。

### `kiki seat`

创建、列出或撤销 Cursor、Claude Code、Codex 等外部 MCP 调用方使用的固定席位。调用方连接前，席位会绑定 workspace、principal、权限模式、模型和 thinking effort。

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

### `kiki mcp`

为外部调用方运行 stdio MCP 边。命令会确保共享 daemon 已运行，创建或复用该工作区席位，并为调用方固定 workspace 与席位策略。

```sh
kiki mcp --workspace <目录>
```

### `kiki migrate-config`

将旧配置和自定义资源复制到 `KIKI_HOME`（默认 `~/.kiki`），不会覆盖已有的 Kiki 文件。只有这条命令会读取旧的 `KIMI_CODE_HOME` 环境变量；未显式指定时，默认来源为 `~/.kimi-code`。它不迁移会话、daemon token、缓存、注册表、锁文件或日志。对项目使用 `--workspace`，将项目的旧 `.kimi-code` 资源复制到 `.kiki`。

```sh
kiki migrate-config --json
kiki migrate-config --workspace <目录> --json
```

### `kiki login`

通过 RFC 8628 device-code 流程登录 Kimi Code OAuth，无需进入 TUI。命令会发起一次 device authorization 请求，将验证地址和用户码打印到 stderr，然后轮询直到浏览器侧完成授权。生成的 token 写入与 TUI `/login` 相同的本地位置，下次启动 `kiki` 时会自动加载。

```sh
kiki login
```

该子命令没有任何 flag。在轮询期间随时按 `Ctrl-C` 可取消登录；取消或失败时退出码为 `1`，成功为 `0`。

### `kiki acp`

把 Kiki 切换到 ACP（Agent Client Protocol）模式，在标准输入/输出上以 JSON-RPC 形式与 IDE 对话，让编辑器直接驱动 kiki 的会话和工具调用。通常不需要手动运行——IDE 会把它作为子进程入口启动。配置方式见[在 IDE 中使用](../server/ide.md)，技术细节见 [kiki acp 参考](../server/acp.md)。

```sh
kiki acp
```

### `kiki web`

在当前终端前台运行本地 Kiki 服务 —— 同一个进程同时挂载 REST + WebSocket API 与 Kiki GUI —— 并在服务就绪后用默认浏览器打开 Kiki GUI。命令会一直挂在终端，直到收到 `SIGINT` / `SIGTERM`（如 `Ctrl-C`）时干净退出。

服务运行时，`GET /openapi.json` 会返回 REST OpenAPI 文档，`GET /asyncapi.json` 会返回本地 WebSocket 协议的 AsyncAPI 文档。用 API 驱动会话的完整流程见[本地服务与 API](../server/local-server.md)，协议细节见[服务 API](../server/rest-api.md)。

```sh
kiki web                 # 前台运行服务并打开浏览器
kiki web --no-open       # 不打开浏览器
kiki web --port 58628    # 指定绑定端口
```

同一 home 目录下可以同时运行多个实例：每个实例注册到 `~/.kiki/server/instances/`，端口被占用时自动 +1 重试（58628、58629……）。

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 绑定端口；默认 `58627`；被占用时自动 +1 重试 |
| `--host [host]` | 绑定地址；缺省 `127.0.0.1`（仅本机），裸 `--host` 绑 `0.0.0.0`（所有网卡） |
| `--allowed-host <host...>` | DNS 重绑定检查额外允许的 Host 头，可重复或逗号分隔 |
| `--log-level <level>` | 按所选级别开启服务日志；默认不输出 |
| `--debug-endpoints` | 挂载 `/api/debug/*` 调试路由（默认关闭） |
| `--dangerous-bypass-auth` | 关闭所有 REST 与 WebSocket 路由的 bearer token 鉴权，使 Kiki GUI 无需 token 即可连接；仅用于可信网络或自有鉴权代理之后 |
| `--no-open` | 就绪后不自动打开浏览器 |

`kiki web` 默认只绑定本机 loopback 地址，并在启动横幅中打印 bearer token；Kiki GUI 通过 URL 的 `#token=` 片段自动完成鉴权。

::: info 提示
`kiki web` 是兼容性的前台命令：它在当前进程中启动独立服务，不会连接或管理共享 daemon。需要控制共享 daemon 的生命周期时使用 `kiki serve`；需要已有前台 REST/WebSocket/web UI 流程时使用 `kiki web`。旧的 `kiki server …` 命令已不再支持。
:::

::: danger 警告
`--dangerous-bypass-auth` 会彻底关闭鉴权。任何能访问该端口的人都能完全控制你的会话、文件系统和 shell。请仅在可信网络或自有鉴权反向代理之后使用，用完后按 `Ctrl+C` 停止服务。
:::

#### `kiki web rotate-token`

生成新的持久化 bearer token（写入 `~/.kiki/server.token`），旧 token 立即失效。token 是整个 home 目录共享的，所有运行中的实例会在下一次鉴权校验时自动换用新 token，无需重启。

### `kiki doctor`

诊断本地 Kiki 连接，不会启动 TUI，也不会修改文件。它会检查 daemon 是否可达、当前 home 的 token 路径与权限、服务端身份以及外部调用方席位列表。默认使用 `KIKI_HOME` 或 `~/.kiki`；如需检查其他 home，可传入 `--home`。报告以 JSON 输出，也不会启动服务；需要先创建服务时，先运行 `kiki serve` 或 `kiki serve --ensure`。

```sh
kiki doctor
kiki doctor --home /path/to/kiki --json
```

报告包含：

- `daemon`：健康 daemon 是否可达；可达时还包含 URL 和 server ID
- `token`：token 路径、是否存在、文件模式以及权限是否安全
- `seats`：不含敏感信息的席位 ID、principal、workspace 和权限模式

### `kiki export`

把一个会话打包成 ZIP 文件，便于分享、归档或提交问题反馈。

```sh
kiki export [sessionId] [options]
```

| 参数 / 选项 | 简写 | 说明 |
| --- | --- | --- |
| `sessionId` | | 要导出的会话 ID。省略时自动选择当前工作目录下最近一次的会话，并要求确认 |
| `--output <path>` | `-o` | 输出 ZIP 文件路径。省略时写入当前目录下的默认文件名 |
| `--yes` | `-y` | 跳过默认会话的确认提示，直接导出 |
| `--no-include-global-log` | | 不打包全局诊断日志。默认包含 |

导出包含目标会话目录内的所有文件。全局诊断日志（`~/.kiki/logs/kimi-code.log`）默认包含，因为它可能含有其他会话或项目的事件；不想分享时加 `--no-include-global-log`。

```sh
# 导出当前工作目录最近一次会话，跳过确认
kiki export -y

# 导出指定会话到自定义路径
kiki export 01HZ...XYZ -o ./bug-report.zip

# 排除全局诊断日志
kiki export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kiki provider`

在 shell 中管理供应商，相当于 TUI 中 `/provider` 的非交互版本。适合脚本化部署、CI 初始化，以及在新机器上一行完成配置。

```sh
kiki provider <action> [options]
```

包含五个动作：

#### `kiki provider add <url>`

从自定义 registry（`api.json`）批量导入所有供应商。命令会拉取 registry，为每个条目创建 `[providers.<id>]` 和 `[models.<alias>]`，并写入 `source` 元数据，使 TUI 下次启动时自动刷新同一 registry 地址下的供应商和模型。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<url>` | Registry 地址 |
| `--api-key <key>` | 访问 registry 时携带的 Bearer token。未传时回退到环境变量 `KIKI_REGISTRY_API_KEY`，必填 |

```sh
kiki provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# 或通过环境变量（适合 CI / .envrc）
KIKI_REGISTRY_API_KEY=YOUR_KEY kiki provider add https://registry.example.com/v1/models/api.json
```

如果某个 provider id 已存在，会先删除再重新写入。不会自动设置默认模型，后续可用 `-m` 或 TUI 内的 `/model` 选择。

#### `kiki provider remove <providerId>`

删除指定供应商及其所有模型 alias。如果被删除的供应商正好是 `default_model` 所属，则同时清空 `default_model`。

```sh
kiki provider remove kohub
```

#### `kiki provider list`

按行打印每个已配置的供应商，含类型、模型数量、来源。加 `--json` 可输出原始的 `providers` 和 `models` 表，便于程序化处理。

```sh
kiki provider list
kiki provider list --json | jq '.providers | keys'
```

#### `kiki provider catalog list [providerId]`

在不修改任何配置的情况下浏览公开的 [models.dev](https://models.dev/) 模型目录。不传参数时列出所有供应商及协议类型和模型数量；传 `providerId` 时列出该供应商下所有模型的上下文窗口和能力。目录地址不可达时会使用内置目录快照。

| 参数 / 选项 | 说明 |
| --- | --- |
| `[providerId]` | 可选，要查看的供应商 id |
| `--filter <substring>` | 按 id 或 name 大小写不敏感子串过滤 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json` |
| `--json` | 以 JSON 形式输出匹配片段 |

```sh
kiki provider catalog list
kiki provider catalog list --filter anthropic
kiki provider catalog list anthropic
```

#### `kiki provider catalog add <providerId>`

按 id 从 catalog 直接导入一个已知供应商，协议类型、base URL、模型信息均由 catalog 提供，只需提供 API key。catalog 未声明协议的供应商（如 xai、openrouter 这类厂商专用 SDK）按 OpenAI 兼容协议导入，并在输出中标注 "guessed"；catalog 未提供可用端点时需用 `--base-url` 显式指定。专有协议（如 Amazon Bedrock）无法导入。公共目录不可达时会回退到内置目录快照，离线或网络受限环境下也能导入。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<providerId>` | catalog 中的供应商 id，如 `anthropic`、`openai` |
| `--api-key <key>` | 供应商 API key。未传时回退到 `KIKI_REGISTRY_API_KEY`，必填 |
| `--default-model <modelId>` | 可选，导入后把 `default_model` 设为 `<providerId>/<modelId>` |
| `--base-url <url>` | 覆盖 catalog 声明的端点；catalog 未提供端点（或仅有环境变量占位符）时必填 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json` |

```sh
kiki provider catalog list anthropic          # 先看可选的模型
kiki provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Kiki daemon 集成

共享 daemon、外部调用方席位与 MCP 配置流程请使用 [`kiki` 命令](../server/daemon.md)。
## 下一步

- [斜杠命令](./slash-commands.md) — 交互式 TUI 内的控制命令速查
- [配置文件](../configuration/config-files.md) — `default_model`、权限模式等启动参数的持久化配置
- [Agent Skills](../customization/skills.md) — `--skills-dir` 加载的 Skill 文件格式
- [Agent 与 subagent](../customization/agents.md) — 内置 subagent、自定义 Agent 文件与通过 `--agent` 选择 main agent
