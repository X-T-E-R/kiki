# 服务 API

`kiki web` 启动的本地服务在 `/api` 下提供 REST API，并在 `/api/ws` 提供 WebSocket 事件流。`GET /api/sessions` 保留扁平的 GUI 会话列表契约；`GET /api/sessions/query` 提供按域分组的高级查询契约。本页是这两组接口的协议参考；服务的启动方式与命令行选项见 [kiki 命令](../reference/command.md#kiki-web)，端到端的上手流程见[本地服务与 API](./local-server.md)。

每个端点的完整请求 / 响应 schema 以服务自描述的规范文档为准：`GET /openapi.json`（OpenAPI）与 `GET /asyncapi.json`（AsyncAPI），两者都需要鉴权。

::: warning 注意
本页描述的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随版本随时更改。集成时请以当前版本服务的 `/openapi.json` 与 `/asyncapi.json` 为准。
:::

## 基础约定

### 地址

默认地址 `http://127.0.0.1:58627`；端口被占用时自动 +1 重试（至多 100 次），可用 `--port` / `--host` 修改。同一 home 目录可并存多个实例，运行中的实例登记在 `~/.kiki/server/instances/`。

### 鉴权

除以下例外，所有 `/api/*` 路径（含 `/openapi.json` 与 `/asyncapi.json`）都要求 bearer token：

- `OPTIONS` 预检请求
- `GET /api/healthz`（探活）
- 静态 web 资源（非 `/api/` 路径）

可信本地客户端使用私有的 `server.local-owner` 凭据。REST 通过 `Authorization: Bearer <token>` 携带；本地 WebSocket 升级接受该请求头或 `kimi-code.bearer.<token>`。远端 GUI peer 则需要有效入站开关、当前 owner 凭据及逐源 grant（HTTP 使用 `X-Kiki-Connection-Grant`）。它们连接 `/api/klient/events`，不使用旧 `/api/ws`。连接管理与转发限 local-owner；四个 thread-bridge 数据端点使用独立桥凭据。配置与轮换见[鉴权](./local-server.md#鉴权)和 [`kiki connections`](../reference/command.md#kiki-connections)。

鉴权失败返回 HTTP 401，信封 `code` 为 `40101`。在非 loopback 绑定上，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，期间一律返回 HTTP 429（`code` 为 `42901`）。

### 响应信封

所有 JSON 响应统一包在信封里：

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

- `code`：业务结果，`0` 表示成功；错误码分段见下文。
- `data`：成功时的业务数据。注意部分「错误」信封也携带非空 `data`——例如重复解决审批返回 `40902` 且 `data.resolved` 为 `false`——客户端应先判 `code` 再看 `data`。
- `request_id`：本次请求的 ULID；客户端可用 `X-Request-Id` 请求头指定，非法值会被服务端重新生成。

HTTP 状态码几乎总是 200，业务结果以 `code` 为准。例外情况：

| 场景 | HTTP 状态 |
| --- | --- |
| 鉴权失败 / 触发限流 | 401 / 429 |
| 创建供应商、导入供应商目录成功 | 201 |
| 删除供应商成功 | 204 |
| 二进制与流式端点 | 支持时返回 206（Range 分段）/ 304（ETag 未变），各端点能力不同，详见「[二进制与流式端点](#二进制与流式端点)」 |
| `GET /api/files/{file_id}` 下载错误 | 真实 404 / 500（响应体仍为信封） |

其中 201 的响应体仍是标准信封（`code` 为 `0`），只是状态行遵循 REST 的资源创建习惯；204 按 HTTP 语义没有响应体，删除成功以状态码本身为准。

### 错误码

错误码按段位分组：

| 段位 | 含义 | 示例 |
| --- | --- | --- |
| `0` | 成功 | |
| `400xx` | 请求参数错误 | `40001` 校验失败（`details` 逐字段说明）、`40003` 供应商由 OAuth 托管 |
| `401xx` | 鉴权与就绪状态 | `40101` 未授权、`40110` 未配置供应商、`40113` 模型未解析 |
| `404xx` | 资源不存在 | `40401` 会话、`40408` MCP 服务、`40409` 文件路径 |
| `409xx` | 状态冲突 | `40901` 会话忙、`40902` 审批已解决、`40922` 分页条件与 `page_token` 不符 |
| `410xx` | 资源已过期 | `41001` 审批超时、`41002` 提问超时、`41003` 临时文件过期 |
| `413xx` | 体积或边界超限 | `41302` 读取文件超 10 MB、`41304` 路径越出会话目录 |
| `429xx` | 限流 | `42901` 鉴权失败封禁、`42902` 文件监听数超限 |
| `500xx` | 服务端内部错误 | `50001` 未捕获异常、`50003` 持久化失败 |
| `6xxxx` / `7xxxx` / `8xxxx` | 工具运行时 / LLM 供应商 / MCP 透传错误，`msg` 保留上游原文 | |

### 分页

列表端点有两种分页风格：

- **游标式**：`before_id` / `after_id`（互斥）加 `page_size`（1–100），响应为 `{ items, has_more }`。用于会话列表、消息列表、转录等。
- **`page_token`**：不透明令牌（内部绑定了查询条件指纹），用于 `POST /api/search` 与 `GET /api/sessions/query`。翻页途中改变任何查询条件会使令牌失效：会话查询返回 `40922`，search 返回 `40001`。`GET /api/sessions/query` 另提供无状态的 `page` 页码模式作为替代。

## REST 端点

按资源分组列出端点。路径里的 `:{action}` 是动作后缀约定——对单个资源 POST 到 `路径:动作` 执行非 CRUD 操作（如会话的 `:fork`、`:archive`）。

### 服务与元信息

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/healthz` | 探活，免鉴权 |
| `GET /api/meta` | 服务版本、能力集、`server_id`、实验开关等 |
| `POST /api/shutdown` | 优雅退出（先回 200 再关闭）；仅 loopback 绑定时挂载 |

### 空间预设

`GET /api/homes/presets` 返回 `{ items: [{ id, name, color?, description }] }`。目前只随包提供 `kiki` 基线预设。从主空间服务调用 `POST /api/homes` 派生空间：

```json
{ "path": "C:/example/space", "preset": "kiki" }
```

路径必须是绝对路径，且目录尚不存在。可选 `name` 和 `color` 覆盖预设的显示默认值。创建返回 `{ id, name, color?, preset?, path }`；`GET /api/homes` 列出有效值。格式合法但未注册的预设返回 `40427`（`space.preset_not_found`）；格式错误、已存在的目录，以及从子空间发起的创建请求返回 `40001`。

空间的 `home.toml` 仍使用 `schema = 1`，新增可选 `preset` 键，不会重写已有 home。省略 `preset` 使用 Kiki 默认值；磁盘上已有的未知预设保留其标识及用户值，回退到 Kiki 默认值，并报告配置诊断。默认配置随包只读，不复制到 `config.toml`：schema 默认值 < 预设 < 继承的 base 配置 < 本 home 配置 < 环境变量（内存覆盖仍最高）。凭据和模型沿用现有 home 继承规则。基线提供显示名 `Kiki` 与 UI 默认值，不改变 Bot 设置，也不安装另一个应用。

`GET /api/config` 提供 `space_ui: { defaultSkin, landingPage, plugins }`。`POST /api/config` 的局部补丁使用 `space_ui: { default_skin?, landing_page?, plugins? }`，落地页限于 `/new` 或 `/bots`。插件清单目前为空，不会安装插件。这些 UI 默认值是客户端契约：客户端应仅在没有用户偏好时应用它们。配置来源新增 `preset`；移除本 home 的覆盖值后，会重新显示较低层的值。

桌面集成可调用原生命令 `create_space_shortcut`，参数为 `{ homeId: "main" }` 或已注册的 `h-…` id；对应适配器方法为 `host.createSpaceShortcut(homeId)`。Windows 返回 `{ homeId, path }`，桌面的 `.lnk` 指向当前可执行文件，并携带 `--home "<空间绝对路径>"`。现有首启及二次启动逻辑会选中该空间，无需安装第二份二进制。命令不会覆盖已有快捷方式。失败携带 `{ code, message }`，错误码包括 `unsupported_platform`、`invalid_space`、`desktop_unavailable`、`executable_unavailable`、`shortcut_exists`、`shortcut_failed`。macOS 和 Linux 暂不支持创建。快捷方式依赖可执行文件与 home 保持原路径；移动其中任一项后，应删除旧快捷方式并重新创建。

### 登录与用量

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/auth` | 登录就绪状态快照 |
| `POST /api/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/oauth/login` | 取消进行中的登录流程 |
| `POST /api/oauth/logout` | 登出托管供应商 |
| `GET /api/oauth/usage` | 查询套餐用量与限额 |
| `GET /api/oauth/userinfo` | 查询账号资料 |
| `POST /api/usage-export/destinations/{id}/auth/begin` | 为某个目的地发起 VibeCafe 登录 |
| `POST /api/usage-export/auth/{id}/poll` | 轮询该次登录 |
| `POST /api/usage-export/auth/{id}/cancel` | 取消该次登录 |

`vibecafe.ai` 目的地的登录方式与 VibeCafe 自己一致，而且只有官方服务提供这一种。`POST /api/usage-export/destinations/{id}/auth/begin` 只接收凭据的存放方式（`keyring` 或 `private-file`）——没有地址、client id 或密钥要填，服务地址固定为 `https://vibecafe.ai`。返回里带 `flow_id`、`state`、`user_code`、`verification_uri`、`expires_at` 和 `poll_after_ms`；按它给的间隔用 `POST /api/usage-export/auth/{id}/poll` 轮询，用 `POST /api/usage-export/auth/{id}/cancel` 取消。`state` 从 `pending` 变成 `connected`、`cancelled`、`denied`、`expired` 或 `error`，不是 `connected` 时由 `error_category` 说明原因。

登录完成只是把凭据存下来，并不会自动开始外送。目的地仍保持 `disabled`，要等你预览过内容再启用，和手动配置的用途地一样。指向自定义地址的目的地、或者你自己提供密钥的那种，走的是手动路径；在那里发起这种登录会得到 `vibe-auth-official-only`，表示此方式不可用。

### 配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/config` | 合并式更新配置，并广播 `event.config.changed` |

会话标题提示词的读取、只读默认值，以及逐字段保存和删除方式见 [`session_title`](../configuration/config-files.md#session-title)。

`hooks` 接受 legacy 命令规则数组，或 `schemaVersion: 2` 的声明式对象。读取和保存均保留完整值，包括 `rules`、`legacy`、`enabled`、`disabled` 和 `files`。嵌套 JSON 键使用 camelCase（`textFile`、`agentRoles`、`everyCompletedSteps`、`counterScope`、`partitionBy`），TOML 使用 snake_case。编辑时发送完整的 hooks 数组或对象；省略 `hooks` 不改动此配置，发送 `[]` 则清空。`null` 或不支持的规则形状返回校验错误码 `40001`，不改变已存文件。读取或保存配置不会执行 hook 命令。支持的事件和动作见 [Hooks](../customization/hooks.md)。

`GET /api/sessions/{session_id}/agents/{agent_id}/hooks` 是独立的只读检查视图。活跃 Agent 返回实际生效的规则、来源状态、诊断和计步值；已关闭的会话则按保存的智能体绑定、计步记录和当前规则来源读取，不恢复 Agent，也不执行 hooks。工作区来源无效时，诊断保留该错误，有效的全局规则仍可查看。此接口不保存配置。

### 模型与供应商

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/models` | 列出已配置的模型别名 |
| `POST /api/models/{model_id}:set_default` | 设置全局默认模型 |
| `GET /api/providers` | 列出供应商 |
| `POST /api/providers` | 创建供应商（201） |
| `GET /api/providers/{provider_id}` | 读取供应商（含已存密钥） |
| `PUT /api/providers/{provider_id}` | 整体替换供应商配置 |
| `DELETE /api/providers/{provider_id}` | 删除供应商（204） |
| `POST /api/providers/{provider_id}:refresh` | 刷新该供应商的模型元数据 |
| `POST /api/providers:{action}` | 集合级动作：`refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/catalog/providers` | 浏览 models.dev 目录（服务端代理） |
| `GET /api/catalog/providers/{catalog_id}` | 读取目录中单个条目 |

### 本机执行器会话

Claude ACP、Codex ACP 与 Codex app-server 提供独立的本机历史目录。来源 ID 不是 Kiki 会话 ID；GET 接口不会将它们导入 Kiki 会话索引。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/executors/{id}/local-sessions?limit=100` | 有界目录；limit 为 1–200，包含 `resume_enabled` 与条目的 `resume.supported` / `resume.reason` |
| `GET /api/executors/{id}/local-sessions/{local_session_id}` | 有界历史预览，包含 `partial` 与 `warnings` |
| `POST /api/executors/{id}/local-sessions/{local_session_id}/resume` | 为来源建立 Kiki 会话绑定，或返回已有绑定 |

续接默认开启；在服务端设置 `KIKI_EXPERIMENTAL_LOCAL_SESSION_RESUME=false` 可关闭新绑定。POST 必须包含从选中条目复制的 `{ "source_home": "…" }`；可选的 `profile`、`model` 与 `thinking` 用于选择初始绑定。显式指定的档案必须使用选中的执行器。响应为 `{ session_id, executor_id, created }`；打开 `session_id`，再发送普通提示词以续跑外部会话。重复请求（包括服务端重启后）返回 `created: false`，不更改已有绑定。若 Codex 来源已经由另一执行器绑定，`executor_id` 表示已有执行器。

新绑定默认使用本地来源的非空 `title` 作为 Kiki 会话标题。没有标题时，使用合并空白后截取前 80 个 Unicode 字符的 `last_prompt`。两者都没有时保持无标题。后续续接请求不会改动已有绑定的标题，包括用户改过的标题。

绑定不会复制外部历史，也不会发送提示词。首条提示词通过 ACP resume/load 或 Codex `thread/resume` 续跑；引擎不支持、引用不可用、绑定指纹变化或来源 home 变化时会报错，不会悄悄新建外部会话。`resume.supported` 反映已知适配器能力与最近一次运行时观测，不等于连接或认证检查。SDK 方法与错误码详见 [klient 契约](https://github.com/X-T-E-R/kiki/blob/kiki/packages/klient/README.md#local-executor-sessions-http)。

### 会话

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/sessions` | 创建会话；同时省略 `workspace_id` 与 `metadata.cwd` 时自动分配新工作区 |
| `GET /api/sessions` | 列出会话，游标分页，支持 `busy` / `archived_only` 和标题、工作区搜索 `q` |
| `GET /api/sessions/{session_id}` | 读取单个会话 |
| `GET /api/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/sessions/{session_id}/profile` | 更新标题、元数据、agent 配置 |
| `POST /api/sessions/{session_id}:{action}` | 会话动作：`fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `POST /api/sessions/{session_id}:delete-archived` | 永久删除已归档对话及仍附属的归档对话 |
| `POST /api/sessions:delete-archived` | 永久删除当前连接 home 中全部归档对话 |
| `GET /api/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/sessions/{session_id}/children` | 创建子会话（fork 并打标） |
| `GET /api/sessions/{session_id}/status` | 实时状态汇总 |
| `GET /api/sessions/{session_id}/goal` | 当前目标快照（无则 `null`） |
| `GET /api/sessions/{session_id}/warnings` | 会话级告警 |
| `POST /api/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流，不走信封） |
| `GET /api/sessions/{session_id}/snapshot` | 客户端重建用全量快照（含 `as_of_seq` 与 `epoch`） |

快照的 `subagents` 名册条目包含可选的 `created_at`，以 UTC ISO 时间表示 Agent 不变的创建时刻。新建 Agent 在首次运行前就带有该值，包括仍在排队时；续跑同一 Agent、恢复其作用域、重启服务或切换模型均不会改变它。fork 若创建了新的 Agent 实体，则记录新的创建时间。另一个可选字段 `started_at` 表示该条目所描述的运行开始时间，后续运行可以更新它。

Agent 的持久元数据若未保存创建时间，就省略 `created_at`；客户端应保留未知状态，不借用会话创建时间、运行开始时间、附着时间，也不从 ID 推断。创建时间使用主机时钟，不是派遣或轮次标识：时间戳相同、时钟变化或缺少比较边界时，不能据此确认 Agent 属于哪次派遣。

要自动分配工作区，可向 `POST /api/sessions` 发送 `{}`。服务端会在 `$KIKI_HOME/workspaces/` 下为该会话新建独立目录并注册工作区；响应中的 `workspace_id` 和 `metadata.cwd` 是新工作区的信息。显式提供已有 `workspace_id` 或 `metadata.cwd` 时仍按原方式定位，未知 `workspace_id` 仍会被拒绝。

创建时设置 `agent_config.execution`，即可独立于 profile 选择 harness：

```json
{ "agent_config": { "execution": { "executor": "claude-acp" } } }
```

选择对象为 `{ executor, profile?, overrides? }`。省略 `profile` 表示外部直连；显式选择的 profile 必须使用同一执行器。`overrides` 接受 `model`、`thinking`、`permission_mode`、`kiki_context`、`allow_kiki_subagents`。执行器与 profile 相同时，省略覆盖字段保留该会话已有覆盖；`null` 删除覆盖并恢复 [下层默认值](../configuration/config-files.md#外部-harness-默认设置)，`[]` 与 `false` 则明确关闭对应能力。旧的顶层 model/profile/thinking 请求仍可使用。

读取会话时，已提交的 `agent_config.execution` 绑定为 `{ version: 1, selection, effective, sources, generation }`。来源取 `session`、`profile`、`harness-settings`、`harness-default`；有效模型或档位未设置表示 Kiki 没有指定，而不是 harness 没有使用模型。厂商报告的模型是观测值，不会变成新的覆盖。空闲时也可通过 `POST /api/sessions/{session_id}/profile` 的 `agent_config.execution` 修改；运行中请随下一条提示词提交选择。

#### `POST /api/sessions/{session_id}:archive`

空请求体保留单会话归档行为。发送 `{ "include_attached": true, "exclude_session_ids": ["independent-thread-id"] }` 可归档仍附属的整组对话。服务器跨所有工作区读取持久元数据，不依赖客户端已加载的页面。`created_by_session_id` 表示创建的线程；`parent_session_id` 只有同时带 `child_session_kind: "child"` 才算附属，普通 fork 不包含在内。排除某个线程会排除其整棵子树；排除请求中的根线程 ID 不会排除根自身。

整组请求返回 `data: { archived, outcomes }`。`archived: true` 确认全部目标已归档；每项结果为 `{ id, ok: true }` 或 `{ id, ok: false, reason, message }`。部分失败时，即使信封 code 为 `0`，`archived` 仍为 `false`；保留成功项，重试完成未归档项。归属发现失败会在任何归档改动之前返回错误。无论成功或失败，都应刷新列表。旧服务器未返回 `outcomes` 时不能确认整组归档。归档不删除历史或 worktree；`:restore` 只恢复请求中的会话。既有批量归档端点仍只操作传入的 ID。

#### 归档对话管理

使用 `GET /api/sessions?archived_only=true`，配合既有 `page_size` 和 `before_id` 游标读取归档。`q` 最多接受 500 个字符，在各页中按标题、工作区路径或工作区 ID 匹配不区分大小写的子串，不搜索消息正文。读取已归档对话的消息不会将其恢复为未归档。

`POST /api/sessions/{session_id}:delete-archived` 接受 `{}` 或 `{ "exclude_session_ids": ["independent-thread-id"] }`。它按[会话归档](#会话)相同的附属关系发现整组对话，排除指定的整棵子树，只删除其中已归档的成员。请求的根对话须仍为已归档；目标在删除前被恢复时会保留。`POST /api/sessions:delete-archived` 接受 `{}`，先发现当前连接 home 中全部已归档对话，再执行删除；搜索、工作区筛选和已加载页面均不收窄范围。独立显示的已归档顶层线程也包含在全部删除中。

两项操作都会永久移除已保存的对话数据，返回 `data: { deleted_ids, failed }`。每个失败项为 `{ id, title?, message }`；`failed` 非空时，信封 code 为 `0` 不代表全部成功。成功、部分失败或请求报错后都须刷新归档列表，按最新状态决定重试。发现目标失败会在删除前返回错误。客户端须在发送请求前取得确认，取消确认不得发送删除请求。

#### `POST /api/sessions/{session_id}:compact`

请求体可以省略。它接受 `instruction`（要保留什么）和 `strategy`，取值为服务端实现的两种续上下文策略 `summarize` 或 `relay`。请求到达时会话空闲就直接开始压缩；仍有模型响应或工具结果正在落进历史时则先排队，等那部分工作结束后的下一个 step 边界处理，不用等整个轮次。

```json
{ "accepted": true, "status": "queued", "source": "manual" }
```

`accepted: true` 表示请求已被受理，**不表示**历史已经压缩完。`status` 描述当时的阶段，取 `queued` 或 `running`；是否完成要看终态的 [`compaction.*` 事件](#事件)，而不是这个响应。已有手动压缩处于排队或执行中时再次请求会返回 `accepted: false`，不会产生第二次；只有收到终态事件、且上一次确实失败时才需要重发。

受理也不保证压缩成功。执行时如果找不到可安全截取的更早历史，会以带 `reason` 的 `compaction.cancelled` 收尾，而不是悄悄放着历史不动；排队的手动请求也不会被随后完成的自动压缩清掉。旧版服务端可能返回空的 `data`，示例中的每个字段缺失都应按可选处理。

### 消息与转录

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |
| `POST /api/sessions/{session_id}/messages/{message_id}:edit` | 替换用户消息，并从该消息重新运行 |
| `POST /api/sessions/{session_id}/messages/{message_id}:regenerate` | 按最新终态 Assistant 消息对应的用户输入重新运行 |
| `GET /api/sessions/{session_id}/transcript` | 转录按轮次分页（需 `agent_id` 和 `transcript_coverage_version=2`），全局状态不分页随响应返回 |
| `GET /api/sessions/{session_id}/transcript/ops` | 转录批次补漏（需 `agent_id`、`since_seq` 和 `transcript_coverage_version=2`），`complete: false` 时需全量刷新 |
| `GET /api/sessions/{session_id}/transcript/user-messages` | 各轮次的用户输入，不分页 |
| `GET /api/sessions/{session_id}/transcript/plan` | ExitPlanMode 计划内容、路径与审阅结果 |

编辑和重新生成都要求会话空闲，并携带当前会话视图的 `expected_cursor: { seq, epoch }`。编辑会替换完整 `content` 数组，包括附件；重新生成沿用所选终态 Assistant 回复对应的原用户输入。预检拒绝不会改变对话历史；成功受理的改写保留 `user_message_id`，并取得新的 `prompt_id`。

需要恢复丢失的响应时，可提供 `operation_id`，并在重试同一次操作时保持该 ID 和完整请求体不变。与已受理请求匹配的重试返回原回执，不再启动一次运行，即使原上传文件已经过期也能恢复。修改请求体或开始新操作时应使用新 ID。同一 ID 携带不同输入会返回 `40938`；游标过期会返回 `40937`，应先刷新会话视图，再开始新操作。响应状态不确定时，手动重试原操作，不要自动提交另一操作。

转录分页与批次补漏请求都须携带 `transcript_coverage_version=2`。成功响应在 `data.transcript_coverage_version` 回显数字 `2`；缺少或使用不受支持的版本时，服务端以信封错误码 `40001` 提示升级，不返回转录。新版客户端读取未确认历史完整性的旧服务端时，会将历史标为未验证，而不是误判为完整。

转录响应的 `agents` 描述符使用 camelCase：`{ agentId, type?, parentAgentId?, delegator?, label?, createdAt?, disposedAt? }`。其中可选的 `createdAt` 与快照 `subagents[].created_at` 表示同一个不变的 UTC ISO 创建时间，活跃会话和已关闭会话均遵循相同的[未知时间规则](#会话)。它不是转录轮次的 `startedAt`，也不是快照运行的 `started_at`。

### 提示词

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式等覆盖） |
| `POST /api/sessions/{session_id}/prompts:steer` | 立即发送选中的排队提示词 |
| `POST /api/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止指定的排队中、启动中、运行中或已追加的提示词 |
| `POST /api/sessions/{session_id}/prompts/{prompt_id}:steer` | 立即发送单个排队提示词 |

提交提示词后若响应丢失，重试时保持可选的 `prompt_id` 和完整请求体不变。匹配的重试返回原受理回执，不会重复提交，main agent、附件和内嵌 Skill 提交也遵循此规则。输入改变时须使用新 `prompt_id`；复用已受理 ID 携带不同输入会返回 `40938`。较早的受理请求若没有可重放回执，应检查队列或历史，不要自动再次发送。

提示词可在顶层 `execution` 携带同一份 [execution 选择](#会话)。选择随该提示词保存，到启动时才应用，而不是入队就生效；当前轮次保持已提交的绑定。execution 代际变化时新建远端会话，不恢复或 fork 旧远端，也不发送旧 Kiki 对话的交接文本；Kiki 中可见的历史仍保留。冷恢复继续使用已提交的代际及其自身保存的远端引用。

顶层 `profile`、`model` 与 `thinking` 选择也随提示词保存。提示词列表项通过可选的 `runtime_controls` 返回这些设置：`execution`、`profile`、`model`、`thinking`、`permissionMode`、`planGate` 与 `planMode`。设置属于该消息，队列恢复后仍保留，不代表另一个切换操作，也不证明绑定已经生效。

立即发送会把普通选中提示词追加到活跃轮次；没有活跃轮次时，则按队列顺序分别启动新轮次。原生提示词只改变 `model` 或 `thinking` 时，会在当前模型响应与工具结果完整落入历史后的第一个安全步骤边界应用设置，随后消费同一条消息一次；在边界前取消该消息不会改变绑定。通过 `after_model_switch` 引用的显式操作仍保留其 `direct`、`compact` 或 `fresh` 模式。main agent 的前台子任务等待可以转入后台，子任务不会被取消。

对于显式切换操作，受理发送不表示切换已完成。切换失败或持久化完成状态不确定时，原消息仍保留在队列中，切换显示可恢复的状态；按同一操作重试即可继续已受理的投递，已取消的切换不会被重新启用。与模型切换无关的 execution 选择仍须独立启动轮次。重启后，立即发送只让选中项绕过恢复确认，其他恢复的提示词仍等待确认。中止已追加的提示词会取消它所加入的轮次，不会取消后续轮次。中止不存在或已经结束的提示词会返回 `40402`。

### 审批与提问

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/approvals` | 列出审批请求（可按 `status=pending` 过滤） |
| `POST /api/sessions/{session_id}/approvals/{approval_id}` | 答复审批 |
| `GET /api/sessions/{session_id}/questions` | 列出提问 |
| `POST /api/sessions/{session_id}/questions/{question_id}` | 回答提问 |
| `POST /api/sessions/{session_id}/questions/{question_id}:dismiss` | 忽略提问 |

### 后台任务

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/tasks` | 列出后台任务 |
| `GET /api/sessions/{session_id}/tasks/{task_id}` | 读取任务（可选输出预览） |
| `POST /api/sessions/{session_id}/tasks/{task_id}:cancel` | 取消任务 |
| `GET /api/cron` | 跨工作区列出定时任务 |
| `POST /api/cron` | 为 `session_id` 创建定时消息 |
| `GET /api/cron/{task_id}` | 读取完整定时消息 |
| `PATCH /api/cron/{task_id}` | 编辑调度或在同工作区内重绑定会话 |
| `POST /api/cron/{task_id}:pause` / `:resume` / `:run` | 暂停、恢复或触发任务 |
| `DELETE /api/cron/{task_id}` | 删除调度 |

任务和定时任务列表支持 `page_size`（1–100，默认 100）与 `offset`（默认 0）。响应包含 `items`、`has_more`，有下一页时还包含 `next_offset`。后台任务列表另支持 `status`，定时任务列表另支持 `session_id`。若两次请求之间任务发生变化，按偏移量翻页可能出现位置偏移。

创建定时消息接受 `session_id`、`cron`、`prompt`，以及可选的 `recurring`、`paused` 和 `delivery_mode`。编辑请求接受除 `paused` 以外的任意非空字段子集；暂停与恢复使用对应操作。`delivery_mode` 可选 `idle`（默认，等待当前工作完成后优先普通消息）、`queue`（按正常消息顺序排队）或 `steer`（下一安全步骤插入，不取消当前请求）。同一任务在空闲等待期间重复触发会合并，并保留总次数。任务响应包含生效的 `delivery_mode`；旧任务未保存模式时，下次触发默认使用 idle，不改变已经入队的投递。投递时机与恢复语义详见[定时任务](../reference/tools.md#定时任务)。

### 技能、工具与 MCP

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/skills` | 会话级技能目录 |
| `GET /api/workspaces/{workspace_id}/skills` | 无会话的工作区技能目录 |
| `POST /api/sessions/{session_id}/skills/{skill_name}:activate` | 激活技能（开启一个轮次） |
| `GET /api/tools` | 列出当前生效 agent 的工具 |
| `GET /api/mcp/runtime/servers` | 列出当前生效 agent 的 MCP 实时连接状态 |
| `POST /api/mcp/runtime/servers/{mcp_server_id}:restart` | 重启 MCP 实时连接 |
| `GET /api/mcp/servers` | 列出 MCP 配置项，包括插件与项目层 |
| `POST /api/mcp/servers` | 添加用户级 MCP 配置项 |
| `GET /api/mcp/servers/{name}` | 读取单个 MCP 配置项 |
| `PUT /api/mcp/servers/{name}` | 替换用户级 MCP 配置项 |
| `DELETE /api/mcp/servers/{name}` | 删除用户级 MCP 配置项 |
| `POST /api/mcp/servers:test` | 测试 MCP 配置但不持久化 |
| `POST /api/mcp/servers:inspect` | 检查 MCP 定位器与 OAuth 候选项 |
| `GET /api/mcp/auth-statuses` | 读取注册表中的 MCP OAuth 状态 |
| `POST /api/mcp/auth:begin` / `:complete` / `:cancel` / `:reset` | 管理 MCP OAuth 流程 |

技能激活请求体可在 `args` 和 `attachments` 之外携带可选字符串 `user_input`。用户通过斜杠命令调用技能时，传入包含空白和换行的完整原始消息。服务端将原文保存为激活来源中的 `userInput`，与展开的技能指令分开保留；GUI 时间线分别显示用户原文和加载的技能文档，不另提交一条消息。

旧客户端可省略 `user_input`；服务端会从技能名和 `args` 生成斜杠文本。已有历史中不含 `userInput` 的记录仍按原方式显示技能文档。

为恢复丢失的激活响应，在首次请求前指定可选 `prompt_id`，人工重试时保持技能名、`args`、`user_input` 和 `attachments` 完整不变。匹配的已接受请求返回原 `{ activated: true, skill_name }` 响应，不会再次激活技能或重读上传附件。同一 ID 下改变内容会返回 `40938`；新的激活动作需要新 ID。省略 `prompt_id` 时保留原无身份激活行为，无法识别丢失响应并安全重放。

### SSH 主机

这些接口管理会话可用的 SSH 主机，不是远端 Kiki 安装目录。主机读取接口可携带 `workspace_id`，选择对应工作区的覆盖值。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/ssh/config-sync` | 读取生效的 SSH 配置同步设置及来源 |
| `PUT /api/ssh/config-sync` | 保存 `{ "enabled": true }` 或 `{ "enabled": false }`，并读回设置 |
| `GET /api/ssh/hosts/{id}:host-keys` | 按已保存主机解析出的主机名和端口，读取本机公开主机密钥记录 |

同步设置的读取和保存均返回 `{ enabled, source }`：`home` 是当前 Kiki home 的持久值，`base` 是继承的值，`default` 是未配置时的默认值（`true`）。设置与主机数量无关；读取失败返回错误，不会退回开启。Klient 方法为 `rest.ssh.configSync()` 和 `rest.ssh.setConfigSync(enabled)`。

`rest.ssh.hostKeys(id, workspaceId?)` 返回解析出的 `hostname`、`port`、匹配用的 `label`，以及 `state`、`records` 和来源 `files`。`recorded` 仅表示本机存在身份记录，不代表刚刚校验过远端密钥。`unrecorded` 表示在可读或不存在的文件中没有找到匹配记录；`unavailable` 表示读取不完整，或匹配记录无法解释。记录包含可读取时的 SHA256 `fingerprint`、`algorithm`、文件与行号、主机匹配模式，以及状态（`recorded`、`revoked`、`unsupported` 或 `invalid`）。不支持的标记（如 `@cert-authority`）、无效公钥和文件错误均携带 `reason`。

OpenSSH 的 `ssh -G` 输出会丢失路径引号。`UserKnownHostsFile` 包含多个文件或路径含空白时，读取返回 `unavailable`，原因为 `ambiguous-known-hosts-paths`；常见的 OpenSSH 双文件默认值也属于此情况，接口不会猜测路径边界。此 API 不连接主机、不修改信任记录，也无法判断远端密钥未变或已变化。首次密钥审批和变化后拒绝连接仍由既有连接流程处理。

### 浏览器连接

这些接口管理已保存的浏览器连接，不是使用它们的会话。读取与保存都不会启动浏览器，也不会访问网站。设置页见[浏览器控制](../guides/settings.md#浏览器控制)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/browser/connections` | 列出已保存的连接与新会话默认项；每行带当前运行状态 |
| `PUT /api/browser/connections/{id}` | 新建或替换一条连接，并读回结果 |
| `DELETE /api/browser/connections/{id}` | 删除一条连接 |
| `PUT /api/browser/default` | 保存 `{ "browser": "<id>" }`；省略该字段可清除默认项 |
| `GET /api/browser/connections/{id}:status` | 只从内存与配置读取运行状态 |
| `GET /api/browser/connections/{id}:tabs` | 列出已连接浏览器的目标标签；不会附着或启动浏览器 |
| `GET /api/browser/connections/{id}:catalog` | 列出执行后端的工具（加 `?includeSchema=true` 时附带输入 schema）；可能启动该后端的 MCP 进程，但从不启动 Chromium |
| `POST /api/browser/connections/{id}:check` | 执行与该接法对应的检查 |
| `POST /api/browser/connections/{id}:connect` \| `:disconnect` | 启动或附着该连接，或释放它 |

`PUT` 使用与 GUI 相同的判别联合请求体。`type` 为 `agent-browser-profile` 时必须给出 `name`，可带 `profilePath`、`executablePath`、`headed`、`driverPath`；`type` 为 `agent-browser-cdp` 时必须给出 `name` 与 `endpoint`，`endpoint` 取值为 `{ "action": "set", "value": "<CDP 的 http 或 ws 地址>" }`，或 `{ "action": "keep" }` 表示保留已存地址。两者都可带 `enabled`，默认 `true`。新建 CDP 连接时未提供 `set` 会被拒绝。已保存的 CDP 地址读回时是掩码；显式读取需用 `POST /api/secrets:reveal`，其 `ref` 的 `kind` 为 `"browser_endpoint"`。

执行类动作失败即关闭：未开启 `native_browser` 实验开关时，`:connect` 返回信封码 `40001`，`details.code` 为 `"browser.disabled"`、`details.reason` 为 `"feature_disabled"`；连接自身被停用时返回的 `details.reason` 为 `"connection_disabled"`。Klient 对应方法为 `rest.browser.list()`、`upsert(id, input)`、`remove(id)`、`setDefault(browser?)`、`status(id)`、`tabs(id)`、`catalog(id, { includeSchema })`、`check(id)`、`connect(id)` 和 `disconnect(id)`。

### 终端

PTY 终端接口，仅 loopback 绑定时挂载。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/terminals` | 列出终端 |
| `POST /api/sessions/{session_id}/terminals` | 创建终端 |
| `GET /api/sessions/{session_id}/terminals/{terminal_id}` | 读取终端（含回滚缓冲） |
| `POST /api/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭终端 |

### 工作区

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/workspaces` | 列出已注册工作区 |
| `POST /api/workspaces` | 注册工作区（按根路径幂等） |
| `PATCH /api/workspaces/{workspace_id}` | 重命名 |
| `DELETE /api/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/workspaces/{workspace_id}/untrust` | 撤销信任 |

### 记忆

`{scope}` 取 `global`、`workspace`、`persona` 或 `persona_workspace`。三个非全局范围需要在查询串里带归属：工作区带 `workspace_id`，角色带 `persona_id`，角色的单工作区笔记两个都要。未知 `workspace_id` 会被拒绝。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/memory/settings` | 读取记忆配置，含 `effective_enabled` |
| `PATCH /api/memory/settings` | 修改 `enabled`、`approval` 或 `budget` |
| `GET /api/memory/workspaces/{workspace_id}/settings` | 读取某个工作区的开关 |
| `PATCH /api/memory/workspaces/{workspace_id}/settings` | 设为 `true` / `false`，或 `null` 表示跟随全局 |
| `GET /api/memory/{scope}` | 搜索或列出条目，过滤与分页见下文 |
| `GET /api/memory/{scope}/{id}` | 读取单条，带 `target`、`applicability` 和 `complete` |
| `PUT /api/memory/{scope}/{id}` | 写入条目；`{id}` 传 `new` 表示新建 |
| `DELETE /api/memory/{scope}/{id}` | 删除条目（`expected_revision` 放查询串） |
| `GET /api/memory/{scope}/inbox` | 列出待审提议 |
| `GET /api/memory/{scope}/journal` | 改动历史，可用 `id` 收窄到单条 |
| `POST /api/memory/{scope}/undo` | 按 `operation_id` 撤销一次操作 |

`GET /api/memory/{scope}` 返回有界分页的 `{ items, mode, next_cursor, coverage }`，不带分页参数时也一样。没有 `query` 时 `mode` 默认 `list`，有 `query` 时默认 `search`；`page_size` 取 1–20。没有显式 `statuses` 时，list 查 `active` 和 `pending`，search 查 `active`，`include_inactive=true` 把两者都放宽到四种。`statuses` 是 `active`、`pending`、`superseded`、`archived` 的逗号串。既有客户端必须消费 `next_cursor`，不能把第一页当成整个命名空间。

持续接续，直到 `next_cursor` 为 null 且 `coverage.exhausted` 为 true。带 cursor 的空准备页不代表命名空间为空。`coverage.complete` 和 `warnings` 说明不可读、非法或过大的记录；这些记录不会隐藏其余可读条目。扫描预算限制单次调用，不永久限制清单大小；搜索相关性排序与列表标题排序针对每个有界源片段。

续读保持同一个 `{scope}` 路径和归属的 `workspace_id` / `persona_id`，只传 `cursor`，不要再带原过滤条件或页大小，混传会返回 `40944`。源内容变化或 store 重启会让 cursor 失效；重新查询并按范围加 ID 对账。`GET /api/memory/{scope}/inbox` 为 `pending` 返回同样的分页形状，接受 `page_size` 或 pending 列表的 `cursor`；其他状态或 search 模式的 cursor 会被拒绝。

`PUT /api/memory/{scope}/{id}` 使用与 [`MemoryWrite`](../reference/tools.md#写入一条条目)相同的动作词表：`action`（`create`、`update`、`supersede`、`archive`）、`type`、`title`、`body`、`reason`、`expected_revision` 和 `pinned`。经 REST 的写入一律记录为来自你，无论 Agent 本会用哪个 `source`。响应是 `{ entry, operationId, outcome, warnings? }`，`outcome` 取 `applied`、`pending` 或 `unchanged`；`unchanged` 以及与已在等待的提议完全相同的重复提交，`operationId` 为 `null`，这两种情况都没有可撤销的操作。`update`、`supersede` 和 `archive` 必须带 `expected_revision`——基于过期版本的 `PUT` 会被拒绝，而不是覆盖掉更新的那一版。

两个元数据字段可选，且「省略」的含义不同：

- **`basis`**——`{ kind, note, refs? }`，`kind` 取 `human`、`observed`、`derived`、`unknown`。它是对象或缺省，永远不是 `null`。`update` 时省略它，只有在 `type`、`title`、`body` 都没变的情况下才保留原依据；改了其中任何一项却没给新依据，这条记忆会降为 `{ kind: 'unknown' }`，并在 `warnings` 里说明依据没有刷新。
- **`validity`**——`{ check, until? }`，`null` 是有意义的：它清除已记录的核对项。`update` 时省略整个 key 表示保留原值，新建条目省略则表示没有记录。没有记录有效性的条目不等于永远有效。

`covered_by` 只在 `archive` 时接受，填同一范围内保留的生效条目的 `{ id, expected_revision }`。存下来的条目以 `{ id, revision }` 记录同一依赖——就是你发过去的那个 revision——并且在真正执行归档时会重新核验，所以对着已经变了的替代条目归档会失败，而不是丢掉仍然需要的规则。

`GET /api/memory/{scope}/{id}` 返回完整条目，外加 `scope`、取 `{ scope, id, expected_revision }` 的 `target`、取 `expired` / `recheck` / `unrecorded` 的 `applicability`，以及 `complete: true`。`target` 是用来定位的对象，不是请求体：`scope` 和 `id` 放路径上，归属的工作区或角色放查询串上，`PUT` 请求体里只有 `expected_revision` 这一个字段取自它，其余是你这次要写的 `action`、`type`、`title`、`body` 和 `reason`。写之前先读：`expected_revision` 对不上的 `PUT` 会返回 `40944`，响应的 `details` 带着 domain 自己的 `code` 与 `recovery`，而信封里的数值 code 仍是既有客户端已在处理的那一个。

### 会话租约与 peer thread

会话租约（lease）是客户端持有的、需定期续期的「在线凭证」：`POST /api/leases` 创建或续期一条租约（默认有效期 60 秒），响应返回 `lease_id` 与 `expires_at`。持有租约可以挂住需要清理的资源（如 PTY 终端与文件监听），并让共享 daemon 在空闲退出判定时保持运行，见 [`kiki serve`](../reference/command.md#kiki-serve) 的 `--idle-exit`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/leases` | 创建或续期租约（body 为可选的 `lease_id`），返回 `lease_id` 与 `expires_at` |

peer thread 接口用于跨会话协作：以 `{ host_id, workspace_id, session_id }` 三元组定位同一台本地主机上的其他会话，读取其已完成轮次或投递消息。工具侧对应 `ThreadList` / `ThreadRead` / `ThreadSend` / `ThreadWait`，概念介绍见 [Agent 与子 Agent](../customization/agents.md#peer-thread-通信)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/threads` | 列出可寻址的 thread，可按 `workspace_id` 过滤，游标分页 |
| `POST /api/threads:read` | 读取一个 thread 已完成的用户与 peer 轮次，可带 `cursor` 续读 |
| `POST /api/threads:send` | 向另一个 thread 持久投递一条消息（需非空 `idempotency_key`，同一 key 只对应同一条消息） |
| `POST /api/threads:wait` | 长轮询等待至多 8 条 thread 的活动，`timeout_ms` 最长 60 秒 |
| `GET /api/workspaces/{workspace_id}/thread-communication` | 读取该工作区 peer thread 通信的持久化覆盖值与生效状态 |
| `PUT /api/workspaces/{workspace_id}/thread-communication` | 持久化该工作区的启用 / 禁用覆盖值 |
| `DELETE /api/workspaces/{workspace_id}/thread-communication` | 清除覆盖值 |

#### 沟通记录

`GET /api/threads/messages` 读取已接收的跨线程消息，不会恢复会话。它不包含普通用户输入、外部 REST / Klient 发送，以及父级与子 Agent 的往来。已归档的会话和关闭新 peer 发送后的既有记录仍可读取。

| 查询参数 | 含义 |
| --- | --- |
| `workspace_id` | 匹配任一仍存在的工作区内端点；省略时查询全部工作区 |
| `session_id` | 读取这个会话发出和收到的消息 |
| `peer_session_id` | 限定一对线程；必须同时提供 `session_id` |
| `limit` | 每页条数，默认 50，范围 1–100 |
| `cursor` | 不透明续页游标；续页时重复相同的工作区、会话和对方筛选条件 |

标准 envelope 的 `data` 为 `{ items, next_cursor?, incomplete?, history? }`。每条消息包含 `message_id`、`source: { kind: "thread", thread: { ref, title?, deleted, archived } }`、`target: { ref, title?, deleted, archived }`、`content`、`accepted_at`（Unix 毫秒时间戳）、`target_seq`、`delivery` 和可选的 `reason`。引用使用主机、工作区、会话三元组。房间唤醒回执的来源为 `{ kind: "room", room_id }`，正文是接收方的 since 汇总而不是逐条房间日志；它只归属于接收方会话及工作区，双线程筛选会排除这些回执。完整讨论应通过房间引用读取 `GET /api/rooms/{id}/log`；房间日志使用独立的正向 `afterId` 游标，不混入以接收方为归属的沟通流。记录按最新时间优先排列；同时间戳按稳定的消息 ID 排序。达到扫描预算时，空页也可能带 `next_cursor`，应继续读取直到没有游标。续页改动筛选条件返回 `40931`（`thread.cursor_invalid`）；选中的会话不存在时返回 `40421`（`thread.not_found`）。

`delivery` 为 `pending`、`delivered` 或 `undeliverable`。Delivered 表示输入已交给对方 prompt，不代表对方已完成回复。邮箱接收前被拒绝的发送，例如目标不存在，不会生成沟通记录。契约保证 `message_id` 同时等于接收方 main agent 的 prompt ID 和对应 User 消息 ID，包括 steer 投递和幂等重试。仅对 `delivered` 记录使用目标会话的 `?block=user-<message_id>` 跳转；`target_seq` 是邮箱序号，不是会话轮次号。已删除的端点标记为 `deleted: true`，另一侧仍存在时记录保留；两侧都删除后，记录从这个视图中消失。

历史读取直接使用已有索引记录，不等待全库历史修复。覆盖范围尚未证明完整时，`incomplete: "history_preparing"` 将准备中与空历史区分开。可选的 `history` 返回 `generation`、`state`（`complete`、`preparing` 或 `error`）、`processedMessages`、`completedShards`、`totalShards`、待准备范围（`room` 或 `all`）以及可选的失败详情。准备期间应从首页重试，不能将没有游标视为完整性证明。游标绑定覆盖代次：补入旧记录或修复完成后，不完整游标会以 `40931` 失效，此时须从首页刷新。升级前的游标也须重新读取首页。GUI 在准备中或失败时不会显示为 "没有记录"，准备期间自动刷新首页，游标失效后重新分页。调用者取消不终止共享修复；修复失败后已有记录仍可读取，但不会声称覆盖完整。

对于 `undeliverable` 记录，`reason_code` 是稳定的本地化键，`reason_detail` 是诊断原文。旧字段 `reason` 保留为 `reason_detail` 的别名。其他投递状态不返回这些字段。没有代码的旧失败记录返回 `delivery_failed`；连接旧服务器的客户端也应使用这个兜底值，而不是翻译诊断原文。

| `reason_code` | 失败类别 |
| --- | --- |
| `thread_not_found` | 目标线程已删除或不存在 |
| `thread_archived` | 目标线程已归档 |
| `communication_disabled` | 线程沟通已关闭 |
| `cross_host` | 不支持跨主机投递 |
| `prompt_rejected` | 目标提示词或请求被拒绝 |
| `session_unavailable` | 目标会话无法打开或已关闭 |
| `workspace_unavailable` | 目标工作区不可用 |
| `executor_unavailable` | 目标执行器失败或不可用 |
| `cancelled` | 投递已取消 |
| `delivery_failed` | 其他失败或没有代码的投递失败 |

Klient 提供 `klient.rest.threads.messages(query, options)`，参数和结果沿用上述 snake_case 形状。`klient.global.threads.messages({ workspaceId, sessionId, peerSessionId, cursor, limit })` 以 camelCase 形状提供同一读取能力，支持 HTTP、IPC 和内存传输。

Peer 消息不再受邮箱原来的 512 条淘汰上限影响。升级后的首个邮箱 owner 会按持久检查点回填仍在邮箱中的记录；旧版本已淘汰的消息不会从会话 wire 重建。依赖新保留规则前，应重启共享同一 Kiki home 的旧进程。

### 房间会话条目

`GET /api/rooms/items` 独立于分页会话列表返回房间摘要。每条包含 `kind: "room"`、`id`、`title`、`workspace`、ISO 时间 `createdAt` / `updatedAt`、`lastSeq`、`memberCount`、`busy`、`needsYou`、`pendingInteraction`（`none`、`approval` 或 `question`）、`failed`、`pinned` 和 `archived`。客户端按活动时间把它们与已加载的线程合并。`workspace` 保留房间自己的工作区根路径，不是成员的工作区 ID；分组或筛选前，客户端根据已注册工作区的根路径解析归属。未匹配的根路径保留在未分组条目中，不借用成员的工作区。置顶条目优先排列。接口包含已归档房间，供客户端应用与线程相同的归档筛选。

通过 `PATCH /api/rooms/{id}` 修改 `name`、`pinned` 或 `archived`；传 `false` 取消置顶或恢复归档。归档会取消房间排队的唤醒并停止其正在执行的房间工作，不会归档成员线程。`DELETE /api/rooms/{id}` 删除房间及其日志投影；房间不存在或补丁非法时返回 `40001`。

与线程一样，已读标记保存在客户端并按空间隔离。`lastSeq` 只随消息、唤醒失败及预算耗尽推进，重命名和置顶不会制造未读。`GET /api/rooms/{id}/log` 返回实际已取条目的 `lastSeq`，因此只加载部分日志时不能把尚未取到的页面标成已读。GUI 使用 `/rooms/{id}` 链接，`/r/{id}` 为短路由别名。

Klient 提供 `rest.rooms.listItems()` 和 `global.rooms.listItems()`。`klient.events.on("room.changed", handler)` 携带 `{ roomId, room, entry?, deleted? }`；已有 WebSocket 事件为 `event.room.changed`，ID 字段为 `room_id`。删除时 `deleted: true`，附带最后的房间文档供缓存失效使用，不表示房间仍然存在。

### 文件系统

会话内文件操作为 `POST /api/sessions/{session_id}/fs:{action}`，动作包括 `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal`，请求体为 JSON。另有：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/workspace/fs:search` | 无会话的工作区搜索（body 携带工作区引用） |
| `GET /api/sessions/{session_id}/fs/{path}:download` | 下载会话文件（二进制，见下文） |
| `GET /api/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/fs:home` | 用户主目录与最近工作区 |
| `GET /api/fs:content` | 按绝对路径预览用户指定的本机文件（包括敏感文件；需要 bearer token，不走 Agent 工具审批） |
| `POST /api/fs:mkdir` | 按绝对路径创建目录 |

会话 `fs:{action}` 工作区 API 只接受工作区相对路径，拒绝绝对路径及符号链接逃逸。这条 GUI 边界不限制另一路 Agent `Read` 工具显式指定的绝对路径。`/api/fs:content` 供已认证用户主动预览，不走 Agent 文件工具审批；不要泄露 bearer token，也不要在不可信网络上关闭认证。

### 文件上传

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/files/{file_id}` | 删除 |

### 全局搜索与其他

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `GET /api/connections` | 列出当前在线的 WebSocket 连接 |
| `GET /api/usage` | 按有界筛选与分页汇总各会话用量 |
| `GET /api/usage/pricing` / `PUT /api/usage/pricing` | 查询模型价格来源或按键修改用户价格覆盖，见下节 |
| `POST /api/external-delegation/seats` / `GET /api/external-delegation/seats` | 创建或列出外部委派席位 |
| `POST /api/external-delegation/seats:resolve` | 按 `{ workspace, principal }` 查找已有席位，返回含委派 token 的席位或 `null`；不创建席位、会话或工作区 |
| `DELETE /api/external-delegation/seats/{seat_id}` | 撤销外部委派席位 |
| `POST /api/sessions/{session_id}/external-delegation/{procedure}` | 调用已获准的外部委派过程 |
| `GET /api/sessions/query` | 新一代会话列表，见下节 |
| `POST /api/sessions:archive` | 批量归档会话，见下节 |
| `POST /api/sessions:restore` | 批量恢复已归档会话，见下节 |
| `/api/debug/*` | 反射式调试 RPC，仅 `--debug-endpoints` 且 loopback 时挂载，不属于稳定协议 |

### 用量来源分组

`GET /api/usage` 支持 `dimension=agent|model|project|session|provider|profile`。原生 `provider` 与 `profile` 维度按每条记录保存的来源分组，包括同一个 Agent 切换智能体档、同一个模型别名切换供应商的情况。智能体档（Profile）指执行档，不是 persona，也不是 main/subagent 身份。

重复 `model`、`provider`、`profile`、`agent.id` 或 `workspace.id` 可选择多个值，例如 `?dimension=profile&profile=explore&profile=general`。同一个筛选字段内取 OR，不同字段间取 AND。`profile` 区分大小写、精确匹配记录的 `profileName`，不读取 Agent 当前档。响应在 `query.profiles` 中返回规范化的筛选值；旧服务器可能省略这个新增字段。

来源组使用不透明键，例如 `provider:"example-provider"` 或 `profile:"explore"`；缺失来源单独使用 `provider:null` 或 `profile:null`，对应归因字段为 `null`。这些记录保留已记录用量，不从模型或 Agent ID 猜来源。筛选值取 `group.provider` 或 `group.profile_name`，不要发送分组键。缺失来源没有筛选哨兵值；字面值 `unknown` 只匹配真实携带这个名称的记录。

查询所选时段或比较窗口时，发送 `range=custom&start_at=A&end_at=B`，边界为 epoch 毫秒的 `[A,B)`。概要、趋势分组与各会话的 `usage` 使用相同的记录筛选和精确窗口；会话金额不混入其他智能体档或时间桶余下部分。费用与 Token 的未知标记仍与已记录数字小计分别表达。保留现有归档、时区和分页参数；修改筛选或窗口后丢弃 `page_token`。

### 全量重扫用量统计

在用量页的历史区点击 **全量重扫用量统计**，扫描所有已索引会话，包括已归档会话。任务仅手动触发，可能耗时较久。`POST /api/usage/rescan` 无需请求体；运行中再次 POST 会返回同一个任务的当前进度。建议每秒轮询 `GET /api/usage/rescan`。两者沿用普通成功信封，`data` 包含 `state`（`idle`、`running`、`completed`、`failed`）、`scanned_sessions`、`total_sessions`、`scanned_records`、`started_at`、`finished_at` 和 `error`。时间为 epoch 毫秒或 `null`；未失败时 `error` 为 `null`。`scanned_records` 计入新读取的所有 wire 记录，包括非用量记录；检查点未变化时无需读取 wire。

任务绕过会话、记录和时间扫描预算，保存增量检查点；运行中常规查询继续读取已提交检查点。常规查询的截止预算为 10 秒，冷扫描会话上限为 500、记录预算为 200,000。成功重扫的会话不再占用冷扫描会话名额：其键清单保存在 `cache/usage-aggregation-v1/full-scan.json`，用量仍保存在原有的逐会话检查点中。常规查询继续校验源指纹，并遵守记录和时间预算。已删除会话与临时用量账本保留常规查询预算。重扫完成不会补造供应商未返回的用量或缺失模型价格。任务进度仅在当前进程内保留，重启后回到 `idle`；检查点与完成会话清单跨重启保留。暂不支持取消。

### 用量计价

`GET /api/usage/pricing` 返回配置中的模型 ID、已保存的覆盖，以及通过重复 `model` 查询参数指定的 ID。每个 `items` 项包含 `model`、配置的 `pricing_model`（未设时为 `null`）、`matched_key`、`source`（`override`、`litellm-cache`、`vendored` 或 `unknown`）和 `prices`（未知时为 `null`）。带路由前缀的模型按价格目录中的规范名匹配；价格是估算，不是代理的实际账单。服务器在 `<home>/model-pricing` 下刷新 LiteLLM 缓存，随包附带的 MIT 许可快照用于离线兜底。

`PUT /api/usage/pricing` 按键修改覆盖：未发出的键保持不变，`null` 删除该键的覆盖。所有单价均为**每 token**，不是每百万 token。提交每百万 token 报价前，先除以 1,000,000。输入、输出单价必填；缓存读、缓存写单价未知时可省略，但使用了未定价类别的请求仍是部分估算。

```json
{"overrides":{"proxy/model":{"input_cost_per_token":0.000002,"output_cost_per_token":0.00001,"cache_read_input_token_cost":0.0000002,"cache_creation_input_token_cost":0.0000025,"currency":"USD"}}}
```

以上仅为示例数字，不是 `proxy/model` 的公开报价。单价必须为有限非负数，`currency` 为三个大写字母。非 USD 覆盖会保存并返回，不做汇率换算，也不计入 `cost_usd_estimated`。未知模型不会获得虚构价格。覆盖沿用原子 TOML 存储，写入 `<home>/model-pricing/overrides.toml`，重启后保留。校验失败返回信封错误码 `40001`，存储失败为 `50001`。HTTP 客户端方法为 `klient.rest.usagePricing.get(models?)` 和 `.set({ overrides })`。

用量检查点按会话持久化。Agent 清单与 wire 字节长度、修改时间不变时，复用已记录的用量，不再读取 wire 边界；追加或指纹变化时增量读取或重建。没有 Agent 的会话计为完整零用量，不占用用量明细行。

### `GET /api/sessions/query`

面向列表页的新一代会话查询，筛选、排序、字段组都在查询参数里：

| 参数 | 说明 |
| --- | --- |
| `workspace.id` | 按工作区过滤，可重复 |
| `activity.status` | 按活动状态过滤：`running` / `approval` / `question` / `failed` / `idle`，可重复 |
| `meta.updated_after` | 只看该时间（epoch 毫秒）之后更新过的会话 |
| `meta.updated_before` | 只看该时间（epoch 毫秒）之前更新过的会话 |
| `meta.archived` | `true` / `false`（默认）/ `all` |
| `sort` | `meta.updated_at_desc`（默认）/ `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | 逗号分隔的附加字段组；目前支持 `git`（分支与 PR 信息，按目录去重并缓存 60 秒） |
| `fields` | 逗号分隔的字段投影；目前仅支持 `id,archived`，每项裁剪为 `{ id, archived }`（用于全选匹配场景）。不可与 `include=git` 同传（`40001`） |
| `page_size` | 1–100，默认 50；使用 `id,archived` 投影时上限放宽至 10000 |
| `page_token` | 上一页返回的翻页令牌 |
| `page` | 无状态的 1 起始页码；与 `page_token` 互斥（同传返回 `40001`） |

响应每项固定包含 `workspace`、`meta`、`activity` 三组，`include=git` 时附加 `git` 组；`fields=id,archived` 时仅返回 `{ id, archived }`。每页额外携带 `total`，即过滤后的集合大小。翻页令牌绑定首页查询条件（含投影），中途改条件返回 `40922`。`page` 模式是跳页用的无状态替代：每次请求都是独立快照，不签发令牌，`next_page_token` 恒为 `null`。

### `POST /api/sessions:archive` 与 `POST /api/sessions:restore`

面向会话管理页的批量归档/恢复。请求体为 `{ "ids": ["session_..."] }`——非空、去重后不超过 5000 条。仍在线的会话走完整生命周期；未加载的冷会话直接改写磁盘上的元数据，不会被加载。

只有请求体校验失败才会让整个请求失败（`40001`）；其余情况按条返回：`data.results` 保持输入顺序，每项为 `{ id, ok }` 或 `{ id, ok: false, error }`（不存在的 id 在自身条目里报 `40401`），并附 `succeeded` / `failed` 计数。

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      { "id": "session_b", "ok": false, "error": { "code": 40401, "message": "session session_b does not exist" } }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

## WebSocket 协议

### 建立连接

唯一端点是 `ws://<host>:<port>/api/ws`，升级请求即完成鉴权（方式见上文「鉴权」）。连接建立后服务端立即发送 `server_hello`：

```json
{
  "type": "server_hello",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": {
    "ws_connection_id": "conn_01JZX4...",
    "protocol_version": 2,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

注意服务端不发送心跳，也不会主动断开空闲连接——保活与重连由客户端自己负责。

### 控制帧

客户端发送 JSON 帧 `{ "type", "id"?, "payload" }`；每个请求帧都会收到应答 `{ "type": "ack", "id", "code", "msg", "payload" }`，`code` 为 `0` 表示成功。

| 帧 | payload | 说明 |
| --- | --- | --- |
| `subscribe` | `{ session_ids, cursors?, agent_filter? }` | 订阅会话事件；带 `cursors`（每会话 `{seq, epoch}`）时回放错过的持久事件 |
| `unsubscribe` | `{ session_ids }` | 取消会话订阅 |
| `subscribe_v2` | `{ session_id, transcript, transcript_since?, transcript_coverage_version: 2 }` | 订阅转录流（唯一的转录订阅通道），`transcript` 按 agent 指定粒度 |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | 退订转录流；省略 `agent_ids` 表示整个会话 |
| `watch_fs_add` / `watch_fs_remove` | `{ session_id, paths, recursive? }` | 订阅 / 取消文件变更通知（`event.fs.changed`） |
| `client_hello` | `{ client_id }` | 握手帧，其余字段为遗留兼容 |

### 事件

事件帧形状为 `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id"?, "timestamp", "payload" }`，`type` 即事件类型。按投递范围分两类：

- **全局事件**：发送到每个已建立连接，无需订阅——`session.meta.updated`、`event.session.created`、`event.session.work_changed`、`event.session.status_changed`、`event.workspace.*`、`event.config.*`。
- **会话事件**：只发给订阅了该会话的连接，受 `agent_filter` 过滤。主要事件族：

| 事件族 | 主要事件 |
| --- | --- |
| 轮次 | `turn.started`、`turn.ended`、`turn.step.started` / `completed` / `interrupted` / `retrying` |
| 流式文本 | `assistant.delta`、`thinking.delta`（带 `offset` 用于对齐） |
| 工具调用 | `tool.call.started`、`tool.call.delta`、`tool.progress`、`tool.result` |
| 交互 | `event.approval.requested` / `resolved`、`event.question.requested` / `answered` / `dismissed` |
| subagent | `subagent.spawned` / `started` / `suspended` / `completed` / `failed` |
| 后台 | `task.started` / `terminated`、`shell.started` / `output` / `completed` |
| 其他 | `compaction.*`、`skill.activated`、`goal.updated`、`prompt.*`、`error`、`warning` |

`compaction.*` 这一族把「谁发起的」和「发生了什么」分开。`compaction.started` 带 `trigger`，取 `manual` 或 `auto`，并可能带 `phase`，取 `queued` 或 `running`；没有 `phase` 即表示 running。`compaction.completed` 带可选的 `trigger` 和一个 `result`；`compaction.cancelled` 带可选的 `trigger`，失败时带 `reason`，没有 `reason` 就是被取消。请依据这些事件判断完成情况，而不是[压缩请求](#post-api-sessions-session-id-compact)的 HTTP 响应——`trigger` 缺省应视为未知，不要据此认定一次手动压缩已完成。排队中的手动请求也不会因为某次自动压缩完成而被结算。

事件另分持久与易失两种：持久事件带严格递增的 `seq`，落盘并可回放；易失事件（各 `*.delta`、`tool.progress`、`shell.*` 等）标 `volatile: true`，不回放。消费易失文本流时用 `offset`（该轮次内的累计字符偏移）与本地已累积文本比对：小于本地长度说明是重复帧，大于说明有缺漏、需走快照恢复。

### 断线恢复

重连后在 `subscribe` 的 `cursors` 里带上每个会话最后应用事件的 `{seq, epoch}`，服务端会回放缺口；落后超过缓冲（1000 条）或游标失效时改为收到 `resync_required`。此时调用 `GET /api/sessions/{session_id}/snapshot` 拿全量快照（含 `as_of_seq` 与 `epoch`），再以新游标重新订阅。

### 转录协议

`subscribe_v2` 的 `transcript` 按 agent 指定粒度：`off` / `turn` / `block` / `delta`（键 `"*"` 表示默认粒度），粒度越高推送越细。只要有非 `off` 粒度，就须在 payload 携带数字 `transcript_coverage_version: 2`；成功应答会回显该值。缺少版本或版本不受支持时，服务端会在发送转录帧前拒绝订阅；所有粒度均为 `off` 时则不要求版本。粒度非 `off` 的 agent 走两帧推送：`transcript.reset`（基线快照，历史经 REST 分页回读）和 `transcript.ops`（增量批次，带每个 agent 连续递增的 `seq`）；该 agent 的旧式事件在同一连接上被抑制，改由转录帧承载。断线时用 `transcript_since` 续传；服务端批次日志无法覆盖缺口时（REST 补漏返回 `complete: false`）需全量刷新。REST 侧对应 `GET .../transcript`（按轮次分页）与 `GET .../transcript/ops?since_seq=`（批次补漏）。

## 二进制与流式端点

以下端点返回二进制流而非 JSON 载荷，各端点的 HTTP 能力并不相同：

| 方法与路径 | 说明 | Range 分段（206） | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/files/{file_id}` | 下载已上传文件 | 支持 | 不支持（会发送 `etag` 头，但不处理 `If-None-Match`） |
| `GET /api/sessions/{session_id}/fs/{path}:download` | 下载会话工作区文件 | 支持 | 支持 |
| `GET /api/sessions/{session_id}/media/{file_id}` | 读取会话媒体文件，包括已保存的工具结果 blob | 支持 | 支持 |
| `GET /api/fs:content` | 按绝对路径预览用户指定的本机文件（包括敏感文件；需要 bearer token，不走 Agent 工具审批） | 支持 | 支持 |
| `POST /api/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流） | 不支持 | 不支持 |

错误语义也不相同：`GET /api/files/{file_id}` 和会话媒体下载对查找和存储失败返回真实 404 / 500 状态码（文件端点的参数校验失败仍走 HTTP 200 信封），其余三个端点的失败走标准[响应信封](#响应信封)——客户端仍需检查信封中的 `code`。

## 下一步

- [本地服务与 API](./local-server.md) — 启动、鉴权与端到端调用流程
- [kiki 命令](../reference/command.md#kiki-web) — `kiki web` 的全部命令行选项
