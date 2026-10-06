# Model Context Protocol

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部进程或服务暴露的工具——例如读取 GitHub issues、查询数据库、操作本地文件系统。Kiki 作为 MCP client 接入这些外部工具，并把它们与内置工具（`Read`、`Bash`、`Grep` 等）一起暴露给 Agent 使用，行为上没有差异。

MCP 工具结果可以携带内嵌媒体。当当前模型无法接收某张内嵌图片——格式不被接受，或该 part 超过单 part 体积上限——Kiki 会同时保留文本提示，并把原件存入会话媒体存储，不会丢失字节。提示中带有已保存文件的绝对路径和 `kimi-file://` 引用；把该路径传给 `Read` 或 `ReadMediaFile` 即可查看原件。Kiki 不直接交付的 resource blob 也会以同样方式保留。当附件清单会挤占工具输出时，清单会写入一个文本文件，输出中只保留指向它的简短指针。

## 接入方式

Kiki 支持三种 MCP server 接入方式：

- **stdio**：CLI 以子进程方式启动本地 MCP server，通过标准输入输出通信。适合本地命令行工具。
- **HTTP**：CLI 连接一个已在运行的 HTTP 端点。适合远程服务或需要持久运行的进程。
- **SSE**：CLI 连接旧式 HTTP+SSE 端点（Server-Sent Events，一种流式 HTTP 机制）。新 MCP server 优先使用 HTTP；只有服务仍仅暴露旧式 SSE 传输时，才设置 `transport: "sse"`。

## 配置

MCP server 配置写在 `mcp.json` 中，分两层：

- **用户级**：`~/.kiki/mcp.json`（或 `$KIKI_HOME/mcp.json`），跨项目共享
- **项目级**：工作目录下的 `.kiki/mcp.json`，只对当前仓库生效

旧的 `.kimi-code/mcp.json` 路径不会读取。

同名条目以项目级为准，覆盖用户级。

在 TUI 中运行 `/kiki-ops 帮我配置 MCP` 可以交互式地新增、编辑或删除 server，无需手动编辑 JSON 文件。运行 `/mcp` 可查看当前所有 server 的连接状态。

从配置中删除某个 server 不会打断进行中的会话：该 server 在 `/mcp` 中仍显示为 `removed`，其工具在这些会话中保持可见，但调用会失败并返回移除提示；新会话则完全不会注册这些工具。反过来，会话进行中新增的 server——无论是编辑 `mcp.json` 还是安装 plugin——都不会注册到已打开的会话中，只会加入之后创建的会话。

当 Kiki 在不受信任的文件夹中发现项目级 MCP server 时，工作区信任提示会显示每个 server 的传输方式和启动目标。提示默认选中 `Trust this folder`；请在确认前核对列出的命令与参数或远程 URL。信任文件夹后，该工作区的项目级 MCP server 才会启用。

`mcp.json` 的结构：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "legacy-events": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

含 `command` 字段的条目为 stdio server；含 `url` 字段且未写 `transport` 的条目为 HTTP server。旧式 SSE server 需要显式把 `transport` 设为 `"sse"`。

可选字段：

| 字段 | 类型 | 适用方式 | 说明 |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | 注入子进程的环境变量 |
| `cwd` | `string` | stdio | 子进程工作目录 |
| `headers` | `Record<string, string>` | HTTP、SSE | 附加到每次请求的静态请求头 |
| `bearerTokenEnvVar` | `string` | HTTP、SSE | 存放 bearer token 的环境变量名 |
| `enabled` | `boolean` | 全部 | 设为 `false` 可禁用该 server |
| `startupTimeoutMs` | `number` | 全部 | 连接超时，取值范围为 `1` 到 `2147483647` 毫秒，默认 `30000` |
| `toolTimeoutMs` | `number` | 全部 | 单次工具调用超时，取值范围为 `1` 到 `2147483647` 毫秒 |
| `enabledTools` | `string[]` | 全部 | 工具白名单 |
| `disabledTools` | `string[]` | 全部 | 工具黑名单 |

连接超时和单次工具调用超时的默认值都不必逐个 server 设置：`config.toml` 的 `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` 或环境变量 `KIKI_MCP_STARTUP_TIMEOUT_MS` / `KIKI_MCP_TOOL_TIMEOUT_MS` 可以调整全局默认值，优先级为 server 字段 > 环境变量 > `config.toml` > 内置默认。详见 [配置文件](../configuration/config-files.md#mcp)。

HTTP 与 SSE server 支持通过 `headers` 或 `bearerTokenEnvVar` 提供静态凭证。需要 OAuth 时，运行 `/kiki-ops 帮我登录 MCP <server-name>` 完成浏览器授权。如果该 server 的授权元数据声明支持 `offline_access`，Kiki 会在登录时一并请求这个 scope，以便之后能续期而不必重新登录；否则按你原本的 scope 授权。声明支持该 scope 的 server 仍可能多显示一次同意页，也不保证一定签发 refresh token。已经登录过的 server 保留现有授权并继续用它续期——新增 scope 不会把你登出。

Plugins 也可以在 manifest 中声明 MCP servers。Plugin 声明的 servers 默认启用，可以在 `/plugins` 中禁用或重新启用：禁用或移除后，已打开会话中的工具调用会失败并返回移除提示；重新启用则会让该 server 立即重连到已打开的会话并恢复工具——前提是会话创建时这个 server 已存在（包括重新启用 `mcp.json` 中 `enabled: false` 的条目）。全新出现的 server 仍遵循上一段的规则：只加入之后创建的会话。详见 [Plugins](../customization/plugins.md#plugin-中的-mcp-servers)。

::: warning 注意
项目级 `.kiki/mcp.json` 中的 stdio 条目会在会话启动时执行本地命令，只在你信任的仓库里启用。
:::

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 格式命名，例如 `mcp__github__create_issue`。权限规则中支持 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具。MCP 工具参数不参与权限匹配。

未命中权限规则的调用会触发审批请求；在审批弹窗中选择"Approve for this session"后，本次会话内的后续同类调用自动放行。

也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

权限规则的完整语法见[配置文件](../configuration/config-files.md#permission)。

## 安全性

接入外部 MCP server 时需注意：

- 只接入可信来源的 server
- 在审批请求中核查工具名与参数是否合理
- 对高风险工具（写文件、执行命令等）维持手动审批，避免用 `mcp__*` 通配放行全部工具

::: warning 注意
在 YOLO 模式下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::

## 让外部客户端使用 Kiki 工具

外部客户端与上文的接入方向相反：支持 MCP 的模型调用 Kiki 原生文件、媒体、Agent、Task、History 和获准的 Memory 工具。Kiki 在普通会话中保存工具活动，main agent 不绑定本地模型。这不会自动导入外部聊天、思考过程或用量。

这项能力目前为实验功能。启动 Kiki host 时设置 `KIKI_EXPERIMENTAL_EXTERNAL_CLIENTS=true`，然后打开 **设置 → 外部客户端**。创建一个有名称的连接，选择共享工作区、工具和权限模式。只有客户端确实需要执行本机命令时，才开启该权限。连接代表权限授权，不代表聊天；初始化和工具发现不会创建业务会话。

### 连接本机客户端

将连接页提供的 stdio 配置复制到 MCP 客户端，其结构如下：

```json
{
  "command": "kiki",
  "args": ["mcp", "--client", "client_YOUR_CONNECTION_ID", "--tools"]
}
```

桥接进程通过本机 owner 通道取得独立的短期凭证。凭证过期时会续期，但不会因业务错误重新提交操作。若 MCP 地址改变，或 host 重启后换了端口，请重启客户端的 MCP 连接，再恢复已保存的业务会话，不要重做它的工作。不要在这份配置中填写 Kiki owner token。原有 `kiki mcp --workspace <dir>` 委派模式与外部客户端模式独立。

### 通过 HTTPS 连接

在同一设置页启用外部 MCP listener，并设置稳定的公网 HTTPS origin。将页面显示的 `/mcp` URL 添加到支持 Streamable HTTP 与 OAuth authorization-code + PKCE 的客户端。在 Kiki 中确认其待授权请求，并选择允许它使用的连接；外部模型不能批准自己的请求。公网 HTTPS 服务或隧道是独立服务，端口已监听不代表客户端能够访问 discovery。

这个 listener 只提供 MCP、OAuth 和健康检查，不提供 GUI、owner API 或 debug API。客户端支持情况和帐号资格由外部产品决定，不能假设每个 ChatGPT 帐号都可添加自定义 connector。Kiki 使用已安装 MCP SDK 的协议协商，不要求尚未发布的协议版本。

### 会话、重试与恢复

客户端通过 `_meta["openai/session"]` 提供 ChatGPT 会话元数据时，每段聊天会映射到该连接下独立的 Kiki 会话。其他客户端先调用一次 `kiki_session`，使用 `action: "new"`，保存返回的 `session_ref`，在后续调用的 `_kiki.session_ref` 中携带它。恢复旧会话需要明确 `resume`，复制引用不会让新聊天悄悄接到旧会话上。

产生副作用的操作必须使用稳定的 `_kiki.idempotency_key`。重试时复用同一调用和 key；同一 key 携带不同参数会被拒绝。长操作和审批会返回 `operation_id`，用 `kiki_operation` 查询，不要重新提交。若 host 停止前未提交操作结果，`outcome_unknown` 表示应先检查目标再明确恢复，不表示可以安全重复执行。

手动审批需要真实的本机审批消费者，没有消费者时工具会被拒绝。外部操作进入审批后，消费者断线不会使它重提或执行；它会继续等待批准或取消。撤销连接会停止未完工作及子 Agent，同时保留记录。修改访问策略会取消未完工作，避免旧审批授权新的策略。

通过 `kiki_save_text` 或会话的便笺编辑器保存明确提供的文本和来源类型。这些是外部记录，不是已核实的用户消息，也不是自动同步的聊天。**本地继续**会预览已保存文本和原生工具记录，再创建独立的本地分支；选择本地模型并明确发送目标后才会开始推理。预览只读取有界子集，不调用模型；材料只加载部分或暂不可读，不等于没有报告材料。大结果可用 `kiki_operation` 的 `action: "read"` 分页读取，并跟随返回的 `next` 请求。文本偏移单位为 UTF-16，媒体偏移单位为字节；媒体块以 base64 resource 返回，来自保存的结果，而不是当前 host 文件。

只向可信客户端授予权限。原生权限和工作区文件检查仍然有效，但本机命令可以使用 host 用户的权限运行进程，不是操作系统沙箱。若共享目录包含 Kiki 的私有 home，请给 `Glob`/`Grep` 指定不包含该 home 的更小搜索目录。Memory 默认只共享工作区，global Memory 需要明确授权，persona 管理不对外暴露。

## 下一步

- [Plugins](../customization/plugins.md) — 在 plugin manifest 中声明 MCP server，一键打包和分发
- [配置文件](../configuration/config-files.md#permission) — 权限规则的完整字段参考
