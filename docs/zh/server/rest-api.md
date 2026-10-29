# 服务 API

`kiki web` 启动的本地服务在 `/api` 下提供 REST API，并在 `/api/ws` 提供 WebSocket 事件流。`GET /api/sessions` 保留扁平的 GUI 会话列表契约；`GET /api/sessions/query` 提供按域分组的高级查询契约。本页是这两组接口的协议参考；服务的启动方式与命令行选项见 [kiki 命令](../reference/command.md#kiki-web)，端到端的上手流程见[本地服务与 API](./local-server.md)。

每个端点的完整请求 / 响应 schema 以服务自描述的规范文档为准：`GET /openapi.json`（OpenAPI）与 `GET /asyncapi.json`（AsyncAPI），两者都需要鉴权。

::: warning 注意
本页描述的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随版本随时更改。集成时请以当前版本服务的 `/openapi.json` 与 `/asyncapi.json` 为准。
:::

## 基础约定

### 地址

默认地址 `http://127.0.0.1:58627`；端口被占用时自动 +1 重试（至多 100 次），可用 `--port` / `--host` 修改。同一 home 目录可并存多个实例，运行中的实例登记在当前 `<home>/server/instances/`（默认 `~/.kiki/server/instances/`）。

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

### 消息邮箱存储升级

home 中存在旧格式消息邮箱，或升级尚未完成时，服务会先进入维护模式，不启动普通引擎、插件或会话。鉴权后的 `GET /api/meta` 返回 `storage_mode: "maintenance"`、`storage_status_path: "/api/storage"`，以及原有的 `server_id` 和 `server_home_id`；不可用的能力标为 `false`。维护模式沿用服务地址、鉴权、Host 检查与 Origin 策略。正常启动前，会话端点返回 HTTP `503`。

| 方法与路径 | 请求 | 响应 data |
| --- | --- | --- |
| `GET /api/storage` | 无请求体 | `StorageMigrationView`；只读状态，不开始迁移或切换存储 |
| `POST /api/storage` | `{ "action": "migrate" }`，或 `cancel`、`rollback`、`start`、`retry_cleanup` | 更新后的 `StorageMigrationView`；启动指定操作 |

`@kiki/protocol` 导出 `storageMigrationViewSchema` 和 `storageMigrationActionSchema`。视图包含 `schemaVersion: 1`、`mode`、`status`、`actions`、`transition`，以及可选的 `operationFailure`。状态提供 `authority`、`phase`、`state`、`progress`、源数据与备份路径、可选的 `writer`、`failure` 和 `warning`，以及 `canCancel` / `canRollback`。这些字段也用于 [`kiki storage --json`](../reference/command.md#kiki-storage)。`mailbox.checkpoint_warning` 表示 SQLite 邮箱可用，但旧迁移进度记录需修复后才能回滚；它不表示迁移失败，也不会提供再次 `migrate` 的动作。

客户端根据 `actions` 显示可操作按钮，不要仅凭阶段和状态猜测：持久阶段已经完成时，工作线程和锁可能还在关闭。`migrate` 续接保留的进度；`waiting` 表示旧 writer 仍持有写入权，应先停止该进程，再在 `migrate` 可用时重试。`cancel` 停止可取消的导入或正常启动尝试。只有恢复原件不会丢失 SQLite 新写入时，才会提供 `rollback`。动作格式错误返回 envelope 代码 `40001`；当前不可执行的动作返回 `40901`；缺少凭据返回 HTTP `401`。

迁移完成后，显式提交 `start` 开始正常启动，并继续轮询同一地址。准备超过 30 秒仍保持 `starting`，可用 `cancel`，不会因固定截止时间自动中止。启动失败或取消时，升级结果保持不变，`transition.state` 为 `"failed"`，`failure` 保留原始启动错误。旧尝试清理期间，`cleanupPending` 为 `true`，`actions` 为空；清理完毕前不能再次启动。清理失败时，`transition.cleanupFailure` 提供原因，唯一可用动作为 `retry_cleanup`；它只重试未完成的清理，不重新启动引擎。清理成功后，`cleanupPending` 变为 `false`，`actions` 才提供 `start` 和仍可用的 `rollback`。

只有 `GET /api/meta` 返回 `storage_mode: "normal"`，且 `server_id`、`server_home_id` 与原值一致时，才切换到正常会话加载。home、身份和端口保持不变，客户端无需另启 daemon。未完成的回退同样进入维护模式，并提供 `rollback`，应先完成回退，再迁移或正常启动。正常模式仍可读取 `GET /api/storage`，但 `actions` 为空。

### 空间预设

`GET /api/homes/presets` 返回 `{ items: [{ id, name, color?, description }] }`。目前只随包提供 `kiki` 基线预设。从主空间服务调用 `POST /api/homes` 派生空间：

```json
{ "path": "C:/example/space", "preset": "kiki" }
```

路径必须是绝对路径，且不同于主 home。目录不存在时会创建；已有文件夹即使非空，也会保留里面的内容。可选 `name` 和 `color` 覆盖新空间的预设显示默认值。如果文件夹已包含继承自此主 home 的有效空间，创建操作会将它登记进列表，保留原身份、名称和设置，不重写 `home.toml`；对同一已登记空间重复请求会再次返回该空间。创建返回 `{ id, name, color?, preset?, path }`；`GET /api/homes` 列出有效值。格式合法但未注册的预设返回 `40427`（`space.preset_not_found`）；格式错误、无效空间信息、属于其他主 home 的空间，以及从子空间发起的创建请求返回 `40001`。

`POST /api/homes:inspect` 接受 `{ "path": "C:/example/space" }`，返回 `{ state }`，其中 `state` 为 `missing`、`empty`、`nonempty` 或 `space`。检查不会改动文件夹。GUI 在提交前据此提示文件夹已有内容或已是一个空间，不会因此阻止创建。

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
| `POST /api/usage-export/destinations/{id}/disable` | 暂停该目的地，不退出登录 |

官方 `vibecafe.ai` 目的地登录时，向 `POST /api/usage-export/destinations/{id}/auth/begin` 发送 `{}` 即可。省略 `storage` 默认为 `auto`：Kiki 将批准后的凭据保存到系统密钥链，密钥链写入失败时自动改存受文件权限保护的私有文件；文件并未静态加密。无需填写地址、client id 或密钥，服务地址固定为 `https://vibecafe.ai`。已有显式 `keyring` 请求仍只使用密钥链；显式 `private-file` 请求仍须提供 `acknowledge_file_storage: true`。Webhook 和脚本的凭据存储选择不变。

返回包含 `flow_id`、`state`、`user_code`、`verification_uri`、`expires_at` 和 `poll_after_ms`。按返回间隔用 `POST /api/usage-export/auth/{id}/poll` 轮询，或用 `POST /api/usage-export/auth/{id}/cancel` 取消。流程从 `pending` 变成 `connected`、`cancelled`、`denied`、`expired` 或 `error`。自动保存的两种后端都失败时，返回 `error` 和 `error_category: "vibe-auth-storage-failed"`；恢复服务器凭据目录或密钥链的访问权限后，重新发起登录。

`connected` 表示凭据已保存，不代表已启用外送。目的地回到 `draft`，保持 `enabled: false`，清除外送授权；预览内容后再启用。`credential_storage` 返回实际使用的 `keyring` 或 `private-file`，重启后仍按该落点读取。自定义地址目的地使用手动凭据，在那里发起设备登录会返回 `vibe-auth-official-only`。

`POST /api/usage-export/destinations/{id}/disable` 暂停已经登录的目的地。它把 `enabled` 设为 `false`，`state` 设为 `"disabled"`，`next_at` 设为 `null`，并停掉正在进行的一次外送。已保存的账号和 `credential_storage` 保留，队列也保留。页面继续显示该账号。**暂停**，以及官方 vibecafe.ai 目的地上的**停用同步**，都调用它。删除已存凭据是另一次移除操作。

#### 供应商与外部服务剩余额度

`GET /api/usage/provider-quotas` 列出已连接来源及缓存的官方额度，不向远端服务发请求。要明确查询一个来源，由 local owner 向 `POST /api/usage/provider-quotas/refresh` 发送 `{ "source_id": "provider:example" }`。向 `PUT /api/usage/provider-quotas/enabled` 发送 `{ "source_id": "provider:example", "enabled": false }` 可关闭额度采集；开启本身不查询、不登录，刷新已关闭来源也不会自动开启。类型客户端对应方法为 `klient.rest.providerQuotas.snapshot()`、`.refresh(sourceId)` 和 `.setEnabled(sourceId, enabled)`。

响应使用 schema version `1`，各来源和额度表项独立。每项提供名称、单位、作用域，以及可选的模型组和重置窗口。未知数值为 `null`，不是零；百分比额度不等于绝对 token 数，金额使用主货币单位，Key、Team 和账户余额不能直接相加。来源状态区分 `unknown`、`ready`、`stale`、`error`、`auth_required`、`off` 和 `unsupported`。旧结果应显示更新时间，需认证时按 `auth.action` 打开现有登录或凭据设置，不把凭据传给额度接口。查询由用户触发，同源并发合并，每次尝试后至少间隔 60 秒，缓存有效期为五分钟；窗口重置时间已过也会标为旧数据。后台不轮询全账户；不支持的服务与执行器自管凭据保持不支持，不拿本地消耗估算厂商余额。

### 配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/config` | 合并式更新配置，并广播 `event.config.changed` |

`request_compression` 和 `responses_web_socket` 是这两次调用上的系统节。省略某一节则保持原值。JSON `null` 删除该节。压缩对象需要 `encoding` 和 `targets`，并可带 `min_bytes` 与 `dictionary`；或者只写 `encoding` 为 `"off"`，不再带其他字段。`dictionary` 只适用于 `zstd`。WebSocket 对象需要 `targets`，或者只写 `off: true` 且不带 `targets`。对象有值但不完整时请求会被拒绝，已保存的文件保持不变。

会话标题提示词的读取、只读默认值，以及逐字段保存和删除方式见 [`session_title`](../configuration/config-files.md#session-title)。

`hooks` 接受 legacy 命令规则数组，或 `schemaVersion: 2` 的声明式对象。读取和保存均保留完整值，包括 `rules`、`legacy`、`enabled`、`disabled` 和 `files`。嵌套 JSON 键使用 camelCase（`textFile`、`agentRoles`、`everyCompletedSteps`、`counterScope`、`partitionBy`），TOML 使用 snake_case。编辑时发送完整的 hooks 数组或对象；省略 `hooks` 不改动此配置，发送 `[]` 则清空。`null` 或不支持的规则形状返回校验错误码 `40001`，不改变已存文件。读取或保存配置不会执行 hook 命令。支持的事件和动作见 [Hooks](../customization/hooks.md)。

`GET /api/sessions/{session_id}/agents/{agent_id}/hooks` 是独立的只读检查视图。活跃 Agent 返回实际生效的规则、来源状态、诊断和计步值；已关闭的会话则按保存的智能体绑定、计步记录和当前规则来源读取，不恢复 Agent，也不执行 hooks。工作区来源无效时，诊断保留该错误，有效的全局规则仍可查看。此接口不保存配置。

### 模型与供应商

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/models` | 列出已配置的模型别名及已存／生效请求格式 |
| `POST /api/models` | 创建绑定到已有供应商的模型（201） |
| `GET /api/models/{model_id}` | 读取模型、生效设置和 revision |
| `PATCH /api/models/{model_id}` | 只修改提供的模型字段 |
| `POST /api/models/{model_id}:set_default` | 设置全局默认模型 |
| `GET /api/providers` | 列出供应商 |
| `POST /api/providers` | 创建供应商（201） |
| `GET /api/providers/{provider_id}` | 读取供应商及凭证来源元数据；密钥值须通过 `POST /api/secrets:reveal` 读取 |
| `PATCH /api/providers/{provider_id}` | 只修改提供的供应商字段 |
| `DELETE /api/providers/{provider_id}` | 删除供应商（204） |
| `POST /api/providers/{provider_id}:refresh` | 刷新该供应商的模型元数据 |
| `POST /api/providers:{action}` | 集合级动作：`refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/catalog/providers` | 浏览 models.dev 目录（服务端代理） |
| `GET /api/catalog/providers/{catalog_id}` | 读取目录中单个条目 |

供应商列表以 `service: "chat" | "decision"` 区分类型；决策行返回 `decision_protocol`、可选 `decision_endpoint`、`effective_base_url` 及空的 `models` 数组。创建决策提供商时填 `type: "system_one" | "pair_score"`、地址和远端 `default_model`，接受 `models: []`。协议及端点归连接；端点覆盖可为路径或同源 HTTP(S) URL，且不含嵌入式凭据。这些连接复用现有提供商凭证、环境变量和自定义请求头，不进入对话模型发现或选择器。见[决策连接](../configuration/providers.md#决策连接)。

`GET /api/providers` 和 `GET /api/providers/{provider_id}` 在供应商保存过 `request_compression` 或 `responses_web_socket` 时返回这两项。不完整的压缩对象、`encoding: "off"`、`off: true`，以及已保存的 `targets` 顺序都按原样返回，不会用系统节补齐。`POST /api/providers` 和 `PATCH /api/providers/{provider_id}` 接受同样的对象。PATCH 里的 JSON `null` 清除该供应商字段。省略的字段保持不变。

目录读取会立即返回最近获取的目录或内置快照，同时合并为一次后台更新。成功获取的目录在十分钟内有效；后台更新失败时，本地目录仍可读取，下一次自动尝试至少间隔十分钟。没有本地目录时，读取等待上游获取，失败则返回错误。显式 `import_catalog` 会等待必要的目录更新，再校验并保存所选条目；上游不可用时，可使用同一份缓存或内置条目。浏览目录不会向你已配置的供应商获取模型列表；这类请求需要显式执行 `refresh`。

创建模型时可选填 `protocol`：`openai`、`openai_responses`、`anthropic` 或 `google-genai`。PATCH 接受相同值；省略 `protocol` 保持原值，`"protocol": null` 清除本地覆盖。带上模型读取结果中的 `base_revision`，可在并发修改时拒绝写入。非法协议值返回 `config.invalid`（业务错误码 `40001`），不改变配置。

模型读取分别返回已保存的 `protocol` 和求解后的 `effective_protocol`。已存值缺省表示继承供应商默认格式；列表中生效值缺省表示未能构建可用 requester。修改模型协议不会写供应商连接、凭据、请求身份或默认指针。配置示例和端点兼容要求见[模型请求格式覆盖](../configuration/providers.md#模型请求格式覆盖)。

单个模型的响应还将已存的 `base_url` 覆盖值与只读的 `effective_base_url` 分开。后者依次取模型覆盖、供应商 URL、供应商环境配置和厂商默认地址；全部未解析到时省略。创建与 PATCH 只接受存储字段，提交时应排除 `effective_base_url`。

### 决策连接

权限审查与记忆顾问分别保存 `source`：`{ kind: "connection", connection, model? }` 引用决策连接，`{ kind: "model", model }` 引用已配置的对话模型别名。通过 `POST /api/config` 写 `permission.reviewer.source`，或通过 `PATCH /api/memory/settings` 写 `advisor.source`。省略则保留，对象整体替换来源。`source: null` 会清除来源及顾问的旧 selector，或将 Reviewer 重置为未配置的 model backend。未设 source 时，旧配置继续工作。权限审查拒绝 `pair_score`；记忆顾问只用这类分数做 `rank`。

配置读取返回 `reviewer.source_status` 和 `advisor_status.source_status`，包含 `state`（`ready`、`unconfigured`、`auth`、`protocol` 或 `capability_mismatch`），以及可解析的连接、模型、协议、origin、目的地和凭证来源元数据，不含凭证值。配置就绪后，仍须一次成功请求确认服务能按所选协议回答。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/decision/probe` | 用虚构内容测试 `{ source, confirm_destination }`，返回 `{ ok, status, duration_ms, reason? }` |
| `POST /api/decision/move-reviewer-key` | 在服务器上转存已保存的旧 Reviewer 密钥；请求 `{ connection }`，返回 `{ connection, state, retryable }` |

`confirm_destination` 须使用该来源报告的精确目的地，将本次测试绑定到该服务。决策连接测试不读取用户记忆，不保存来源；`status` 使用上述来源状态结构。[已保存顾问的测试](#记忆)则读取顾问配置，返回顾问状态及可选 token 用量。

密钥转存会先创建连接，切换 Reviewer 来源，再删除旧密钥；调用方不会收到密钥。`complete` 表示全部完成，`connection_saved` 和 `source_switched` 表示后续写入失败或遇到并发设置变化前完成的阶段。重试前先刷新连接和 Reviewer；只有名称仍对应同一密钥和设置时才沿用，Reviewer 密钥已换新而连接仍持旧密钥时应换新名称。冲突连接和较新设置会保留。通过环境变量使用 Jev 时无需转存。

### 执行器目录与检查

执行器目录列出已注册的引擎，不等待可执行程序发现或认证检查。读取目录不会启动引擎，也不会执行登录。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/executors` | 已注册引擎及其最近一次检查。此请求不探测。超过 60 秒的结果带 `check_stale: true` |
| `GET /api/executors/{id}` | 单个引擎的能力、连接设置及最近一次检查。此请求不探测 |
| `POST /api/executors/{id}/check` | 只检查该引擎的可执行程序来源和它声明的认证信息 |
| `GET /api/executors/installations` | 固定版本的适配器，以及已选中的源码自有适配器。此请求不安装。没有安装记录的条目省略 `active` |
| `POST /api/executors/{id}/install` | 显式更新一个选中的适配器。请求没有正文字段 |
| `POST /api/executors/{id}/rollback` | 恢复该适配器的上一份安装。请求没有正文字段 |

目录 `status` 取 `ready`、`unavailable` 或 `unknown`。原生引擎始终为 `ready`。外部引擎还没有检查结果时为 `unknown`。`check_status` 保留最近一次显式检查的 `ready`、`warning` 或 `unavailable`，`checked_at` 是该次时间。启动配置未变时，60 秒内 `check_stale` 为 false；超过 60 秒后变为 true，列表仍返回上一次的 `check_status`，而不是回到 `unknown`。引擎修订变化后，这两项消失，该引擎重新成为尚未检查。`POST` 只更新被点名的引擎。其他引擎保持各自已有的结果，一个引擎超时或失败时，其余引擎不会被写成就绪。`GET` 不启动探测。

程序就绪与认证分开存放。`connection.login_status: "unknown"` 表示登录态还没有读到。目录 `status: "ready"` 只表示程序要求通过。预检为 `warning` 且程序要求通过时，目录 `status` 为 `ready`，`check_status` 仍为 `warning`。新的 profile 选择和裸执行入口只包含 `show_in_profile_list` 为 `true` 的外部引擎。字段不存在时留在设置页。`false` 在刷新、重查和再次导入之后仍然关闭。`externals_visible = false` 挡住全部外部新选择。裸执行入口还要求程序就绪，并且已确认登录或已配置该引擎声明的 API 密钥环境变量。已经绑定隐藏或不可用引擎的 profile 与会话保留该身份。设置页仍列出全部引擎。发送提示词仍执行真实的程序、来源及认证校验；显示目录里的上一次检查不能代替启动检查。

`POST /api/executors/{id}/install` 和 `POST /api/executors/{id}/rollback` 使用你选中的执行器 id，这个 id 不是固定值。不是可安装适配器的 id，包括路径查找，返回未找到，并且不改文件。

源码自有更新只在同时满足这些条件时写入：该执行器选中的来源是唯一一条 `node-script`，文件名是 `agy-cli-acp.mjs`，并且路径在展开 `~` 和 `${KIKI_HOME}` 之后是绝对路径。选中的脚本多于一条时，不是这次更新。

安装只替换该脚本旁边的三个文件：`agy-cli-acp.mjs`、`agy-hook-registration.mjs` 和 `agy-permission-hook.mjs`。同目录里的其它文件保留，包括自定义脚本和 `audit/` 记录。这次调用不改写执行器的 env、模型、权限或 `supports_mcp`。`supports_mcp` 保持原值。状态 JSON 含有 `id`、`release`、`active`、`previous` 和 `phase`，不包含 `supports_mcp`。对这个 bundle，`release.source` 是 `bundled:external-harness`，`release.entry` 是 `agy-cli-acp.mjs`，`active.version` 是 `0.4.1`。

替换后的文件在该执行器进程下一次启动时被读取。这次请求不重启已经在运行的进程。

存在上一份安装时，rollback 恢复这三个文件的上一份副本，自定义文件留在原地。再 rollback 一次会把这两份副本对调。安装在替换这三个文件之前先保存它们的当前快照。写入失败时写回原字节，删除原先不存在的新文件，并且调用失败。安装记录保存失败时，安装恢复那份更早的副本，并且调用失败。rollback 记录保存失败时，rollback 恢复当前生效的副本，并且调用失败。若这次恢复也失败，响应是校验码 `40001` 和具体的恢复诊断，已保存的安装记录保持原样，调用不会报成功。

`GET /api/executors/installations` 也可以列出 `claude-acp`、`codex-acp` 这类固定版本，其 `phase` 为 `idle`，且没有 `active`。列出它们不会安装。

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
| `GET /api/sessions/creation/{creation_id}` | 查询创建回执，不创建或恢复会话 |
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

会话在本进程中不是 live 时，快照从已保存的 main agent wire 和会话元数据读取，不会恢复该会话或其 workspace。`messages` 是压缩、撤销和编辑之后的当前逻辑 context 里最新的 100 条，按从旧到新排列。更早的逻辑条目仍存在时 `has_more` 为 true，`message_count` 等于该逻辑长度。`as_of_seq` 和 `epoch` 是会话 journal 水位。权限模式和 plan mode 来自已保存的 runtime 记录；模型和思考强度来自已保存的 agent 绑定。本进程没有测量过的 context token 总量和 breakdown 会省略。`in_flight_turn`、`pending_approvals` 和 `pending_questions` 只描述本进程里的活动，另一个进程里仍在运行的会话不会在这里被标成本地 active。

会话读取与 `event.session.work_changed` 将 `executing` 与 `busy` 分开提供。`busy` 包含未完成工作、排队提示词和等待投递的已结束任务结果。`executing` 表示当前本地执行或有限生命周期的进程、媒体任务，不包含这些队列、未投递的终态结果、常驻服务，以及没有活动执行器的 Agent 任务条目。冷会话对本进程报告 `executing: false`。旧版服务端省略该字段，省略表示未知。历史子 Agent 条目的 `status: "running"` 不构成当前正在执行的证据。

快照的 `subagents` 名册条目包含可选的 `created_at`，以 UTC ISO 时间表示 Agent 不变的创建时刻。新建 Agent 在首次运行前就带有该值，包括仍在排队时；续跑同一 Agent、恢复其作用域、重启服务或切换模型均不会改变它。fork 若创建了新的 Agent 实体，则记录新的创建时间。另一个可选字段 `started_at` 表示该条目所描述的运行开始时间，后续运行可以更新它。

模型、思考强度与执行器字段优先使用 Agent 当前已提交的元数据，当前值缺失时才回退到创建快照。思考强度来源与执行器协议沿用所选数据源；当前绑定本身不证明哪个模型处理了真实请求。

Agent 的持久元数据若未保存创建时间，就省略 `created_at`；客户端应保留未知状态，不借用会话创建时间、运行开始时间、附着时间，也不从 ID 推断。创建时间使用主机时钟，不是派遣或轮次标识：时间戳相同、时钟变化或缺少比较边界时，不能据此确认 Agent 属于哪次派遣。

要自动分配工作区，可向 `POST /api/sessions` 发送 `{}`。服务端会在 `$KIKI_HOME/workspaces/` 下为该会话新建独立目录并注册工作区；响应中的 `workspace_id` 和 `metadata.cwd` 是新工作区的信息。显式提供已有 `workspace_id` 或 `metadata.cwd` 时仍按原方式定位，未知 `workspace_id` 仍会被拒绝。

要安全重试创建请求，先生成一个 UUID，放入可选的顶层字段 `creation_id`；超时或断连后重试时，保留该 ID 和原请求体。匹配的并发请求共享一次创建；已完成的请求返回保存的结果，服务重启后也不会重新创建。已保存的失败也会原样返回，不会重复执行创建副作用。会话 ID 固定为 `session_<creation_id>`，其中 UUID 统一为小写。

创建身份归属于当前连接的 home，客户端须为不同 home 和连接分别保存待确认请求。不传 `creation_id` 时保留普通创建行为，不对重试去重。取消客户端等待不会删除服务端已经创建的会话。

结果未确认时，调用 `GET /api/sessions/creation/{creation_id}`。响应为 `{ creation_id, session_id, status, session?, failure? }`；`status` 取 `missing`、`pending`、`completed`、`failed` 或 `unknown`。该查询既不等待正在进行的创建，也不发起创建。只有 `completed` 包含已保存的会话响应；`missing` 时可用原 ID 和原请求体重试。查询失败时继续保留未知状态。

| 创建错误码 | 恢复方式 |
| --- | --- |
| `40948` | 创建身份发生冲突。`details.reason` 为 `body_mismatch` 时，同一个 `creation_id` 携带了不同请求体；为 `session_id_exists` 时，映射出的会话 ID 已被本次创建之外的调用占用。保留待确认身份和草稿，不把冲突当成幂等成功；只有明确要另建会话时才使用新 ID。 |
| `50006` | 创建结果尚未确认。`details` 为 `{ creation_id, session_id, evidence }`。诊断值包括 `session_present_without_completion`、`session_absent`、`completion_receipt_write_failed`、`session_read_error` 和 `receipt_read_error`；客户端也须保留不认识的新诊断值。保留草稿和创建身份，按准确会话 ID 检查结果。此错误码不代表可以安全另建，服务端不会重新执行创建或其 hooks。 |

创建时设置 `agent_config.execution`，即可独立于 profile 选择 harness：

```json
{ "agent_config": { "execution": { "executor": "claude-acp" } } }
```

选择对象为 `{ executor, profile?, profile_file?, overrides? }`。可选择已注册的 `profile` 名称，或 `profile_file` Markdown 路径；两者互斥，所选 profile 必须使用同一执行器。显式文件不要求 `main: true`，不会被注册或复制进 profile 目录。同时省略这两个字段表示外部直连。`overrides` 接受 `model`、`thinking`、`permission_mode`、`kiki_context`、`allow_kiki_subagents`、`native_agent` 和 `inject_kiki_mcp`。执行器和 profile 名称或文件路径相同时，省略覆盖字段保留该会话已有覆盖；`null` 删除覆盖并恢复 [下层默认值](../configuration/config-files.md#外部-harness-默认设置)，`[]` 与 `false` 则明确关闭对应能力。`native_agent` 取 `engine-default` 时保留厂商默认 Agent，且不发送自定义选择。新值必须已被宣告。尚未发现时，只有执行器、该 Agent 和描述符版本仍与当前绑定一致，已有选择才会保留；发现结果不含该值时拒绝，当前绑定保持不变。`inject_kiki_mcp: true` 打开工具桥，但不会授予绑定已经拒绝的工具；`false` 关闭工具桥。旧的顶层 model/profile/thinking 请求仍可使用。

选文件前可用 `POST /api/agent-profiles/file-preview`，请求为 `{ path, cwd?, workspace_id? }`，响应为 `{ profile }`，包含普通 profile 元数据、规范绝对路径 `source_file` 和执行器。`cwd` 与 `workspace_id` 最多传一个；相对路径必须指定其中一个，绝对路径或 `~/` 路径则无需指定。路径由当前连接的服务端读取，不是客户端本机路径。缺失或非法文件返回 `40001` 和带路径的诊断，不改变绑定。typed HTTP 客户端对应 `klient.rest.agents.previewFile(body, options?)`。创建会话或发送下一条消息时，把返回的 `source_file` 作为 `execution.profile_file`。

读取会话时，已提交的 `agent_config.execution` 绑定为 `{ version: 1, selection, effective, sources, generation }`。来源取 `session`、`profile`、`harness-settings`、`harness-default`；有效模型或档位未设置表示 Kiki 没有指定，而不是 harness 没有使用模型。厂商报告的模型是观测值，不会变成新的覆盖。空闲时也可通过 `POST /api/sessions/{session_id}/profile` 的 `agent_config.execution` 修改；运行中请随下一条提示词提交选择。

Agent 空闲时，`agent_config` 里的 `thinking: null` 只清除会话上的思考强度覆盖，更低优先级的强度因此重新生效：先是 profile，然后是 harness 设置；Kiki 没有钉住强度时，才回到引擎默认。不带 `model` 会保留已保存的模型。空的思考强度字符串会被拒绝；省略 `thinking` 则保持当前强度。Agent 仍在运行时，这次 profile 更新会被拒绝。提示词可以携带同样的 `thinking: null`，Kiki 在该提示词启动时应用它，省略的 `model` 仍保留。

创建会话和更新 profile 均接受 `agent_config.plan_gate: "free" | "gated"`。profile 更新直接应用到 live main agent，无需发送提示词；live 快照返回生效的 `plan_gate`。该覆盖只持续到当前 Agent 实例关闭，恢复后重新使用配置中的 gate；冷快照省略此字段。要通过 klient 让指定 Agent 退出 Plan 模式，调用 `klient.session(sessionId).agent(agentId).exitPlan()`；它的父 Agent 和同级 Agent 保持各自的模式。

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
| `GET /api/sessions/{session_id}/transcript/detail` | 读取一条 canonical 实体（`agent_id`、`kind`、`id`） |
| `POST /api/klient/session-view/{session_id}/transcript/content` | 从一条 `contentRefs` 继续读取被截断的字段 |

编辑和重新生成都要求会话空闲，并携带当前会话视图的 `expected_cursor: { seq, epoch }`。编辑会替换完整 `content` 数组，包括附件；重新生成沿用所选终态 Assistant 回复对应的原用户输入。预检拒绝不会改变对话历史；成功受理的改写保留 `user_message_id`，并取得新的 `prompt_id`。

需要恢复丢失的响应时，可提供 `operation_id`，并在重试同一次操作时保持该 ID 和完整请求体不变。与已受理请求匹配的重试返回原回执，不再启动一次运行，即使原上传文件已经过期也能恢复。修改请求体或开始新操作时应使用新 ID。同一 ID 携带不同输入会返回 `40938`；游标过期会返回 `40937`，应先刷新会话视图，再开始新操作。响应状态不确定时，手动重试原操作，不要自动提交另一操作。

转录分页与批次补漏请求都须携带 `transcript_coverage_version=2`。成功响应在 `data.transcript_coverage_version` 回显数字 `2`；缺少或使用不受支持的版本时，服务端以信封错误码 `40001` 提示升级，不返回转录。新版客户端读取未确认历史完整性的旧服务端时，会将历史标为未验证，而不是误判为完整。

向前翻页时，如果服务端仍在已保存的历史中定位锚点，可能返回空 `items`、`has_more: true` 和 `read.readiness: "preparing"`，此时 `read.source` 为 `cold` 或 `derived`。把返回的 `next_cursor` 作为 `before_item` 继续请求，即使游标与上次相同。空页或重复游标都不表示已经读到开头。返回正文后，沿新游标继续；读到正文也不代表历史已完整验证，应保留响应中的 `coverage` 与 `read` 状态。

`GET /api/sessions/{session_id}/transcript/detail` 读取一条实体。查询参数 `agent_id` 是普通 Agent id，`kind` 取 `task`、`attachment`、`prompt` 或 `tool`，`id` 是该实体的 id。`kind=tool` 时，`lookup.status` 为 `found`、`preparing` 或 `not_found`。`found` 带有 `turnId`、`stepId` 和 `frame`。返回的 `frame`，以及 task、attachment、prompt 正文，可能带 `contentRefs`；用下面的 POST 续读。`preparing` 表示这次调用尚未在会话的源历史中定位到，用同一请求重试。此时 `read.source` 为 `derived`，`read.readiness` 为 `preparing`。`not_found` 表示已经定位的历史里没有这次调用。

已在内存中覆盖完整的会话直接返回实时工具调用，`read.source` 为 `live`，`readiness` 为 `ready`。已定位的冷会话返回 `cold` 和 `ready`，正文从这份源历史回放。旧格式消息与内容块的 `provenance` 在已知时携带绝对 `recordOrdinal`。有界冷窗口尚未验证文件前缀时，改为携带逻辑 wire 中的绝对字节范围 `recordSpan: { startByteOffset, endByteOffset }`，省略 `recordOrdinal`。不要把缺失的序号当作零，也不要从分页位置推算。实体 ID 是不透明标识；历史导航就绪后，仍应原样提交返回的引用。

转录页把大字段留在 `contentRefs` 里。每条引用包含 `source`、`revision`、`path`、`kind`（`text`、`array` 或 `object`）、`offset` 和 `total`。用 `POST /api/klient/session-view/{session_id}/transcript/content` 继续读取，JSON 为 `{ "agentId", "ref" }`，`ref` 原样送回。HTTP 状态保持 200，结果在信封里。`code: 0` 返回 `value`；字段还有剩余时带 `next`。把这份 `next` 原样作为下一次的 `ref` 提交，直到响应不再带 `next`。再次提交同一条 `ref` 读到的仍是这一段；`"range": true` 不会推进 `offset`。对文本引用，它只限制已经放在 `offset` 上的那段切片（大约 4096 个字符，且仍在字段预算内），快照引用会忽略 `range`。单页预算为 64 KiB，每个字段切片瞄准其中一半，即 32 KiB。

源历史仍在定位时，同一次调用返回 `code: 40923` 和 `msg: "history_canonical_preparing"`，用同一请求体重试。字段已与引用不一致时，返回 `code: 40922` 和 `msg: "Content changed; reload its preview before continuing."`。重新加载转录预览，再从新的引用继续。未知引用返回 `code: 40401` 和 `msg: "content unavailable"`。其他路由也会使用 `40922` 和 `40923`；以这条 `msg` 为准。请求体无效时返回 `code: 40001` 和 `msg: "invalid content reference"`。

转录响应的 `agents` 描述符使用 camelCase：`{ agentId, type?, parentAgentId?, delegator?, label?, createdAt?, disposedAt? }`。其中可选的 `createdAt` 与快照 `subagents[].created_at` 表示同一个不变的 UTC ISO 创建时间，活跃会话和已关闭会话均遵循相同的[未知时间规则](#会话)。它不是转录轮次的 `startedAt`，也不是快照运行的 `started_at`。

### 提示词

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式等覆盖） |
| `POST /api/sessions/{session_id}/prompts:steer` | 立即发送选中的排队提示词 |
| `POST /api/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止指定提示词；`?queued_only=true` 只移除尚未启动的队列项 |
| `POST /api/sessions/{session_id}/prompts/{prompt_id}:steer` | 立即发送单个排队提示词 |
| `GET /api/sessions/{session_id}/prompts/{prompt_id}?admission=durable` | 读取已保存请求的完整内容，不恢复 Agent |
| `POST /api/sessions/{session_id}/prompts/{prompt_id}:resume?admission=durable` | 重试等待确认或失败的已保存请求 |

已保存的会话通过 `admission: "durable"` 和长度为 1–256 字符的稳定 `prompt_id` 显式选择保存。会话仍在恢复时保存是其中一种用途；门槛是会话已经保存，而不是恢复正在进行。其他 `admission` 值会在正文落盘前被拒绝。不存在的会话，以及仍在运行但尚未保存的临时会话，也会在落盘前被拒绝，并且不会产生受理回执。

服务端随后保存完整请求和上传附件，并返回 `status: "queued", admission: "restoring"`。这一对值表示消息已持久化、等待恢复，不是 Agent 已经受理。成功的 HTTP 信封只确认这次保存。

请求格式错误、空消息、目标不存在或上传附件不可用会在回执前报错；模型、profile 和执行校验在恢复阶段进行。省略 `admission` 保持原同步启动或阻止响应，也不会写入这份持久副本。`?receipt=true` 返回不回显完整内容的精简回执。

通过 `GET /api/sessions/{session_id}/prompts?admission=durable` 读取 `ingress`。将 `ingress_next_cursor` 作为下一页的 `cursor`，直到不再返回游标；即使某一页没有所选 Agent 的条目，也应继续翻页。每页最多扫描 64 个已保存请求，文本预览最长 1024 个字符，并带 `admission_content_truncated: true`。没有文本的已保存请求预览为 `[Attachment]`。原文使用单项读取接口。这两种读取都不加载冷 Agent。目标为子 Agent 时，提交正文及每次查询、操作都须带同一 `agent_id`。

`admission: "admitted"` 表示 Agent 已受理请求，`status` 是保存的回执状态，不代表当前队列位置或模型已经消费。立即发送时，可选的 `delivery_state: "steered"` 表示核心已将消息分配给目标轮次，`"queued"` 表示记录该回执时仍在等待投递，也包括等待模型切换边界的情况。分配或受理都不证明消息已进入模型请求；应以转录中的实际投递帧及后续请求为准。较新的 canonical 启动、追加或终态事实优先于旧 queued 回执。

可选的 `delivery_reason` 在提交回执和持久请求读取中说明立即投递的实际决定。单 ID 的 `:steer` 响应也携带 `delivery_state` 和 `delivery_reason`；`steered: true` 表示消息已加入当前回合，`steered: false` 表示仍在排队或已离开队列。已不在可选队列中的已知提示词返回 `prompt_no_longer_pending`，不再报 404；未知 ID 仍返回 `40402`。多 ID 回执不返回单条提示词字段。调用 `:abort?queued_only=true` 时，`aborted: true` 确认未启动项已从队列和时间线移除；`aborted: false` 表示未移除，应刷新读取当前状态。已启动回合及其历史不受影响。普通 `:abort` 仍可停止运行中的提示词。

| `delivery_reason` | 含义 |
| --- | --- |
| `target_changed` | 投递前活跃轮次或提示词已改变，消息保留在队列中。 |
| `steer_rejected` | 核心拒绝插入当前轮次，例如执行控制不兼容。 |
| `executor_deferred` | 外部执行器未将该消息投递到当前运行，消息仍排队等待后续轮次；这不区分操作不受支持或执行器拒绝投递。 |
| `model_switch_boundary` | 投递正在等待所选模型切换边界。 |
| `no_active_turn` | 没有可加入的活跃轮次，选中消息沿新轮次路径启动。 |
| `external_retry` | 已知的外部提交回执被重放，没有重复执行立即投递动作。 |
| `prompt_no_longer_pending` | 该提示词已不在可选的待发送队列中；仅凭这一原因既不能确认已投递，也不能认定仍在排队，应读取 canonical 状态。 |

`failed` 带有 `admission_error`，原文与附件仍保留。重启后或投递结果不确定的请求转为 `held`，等待显式 `:resume`；服务端会先核对原回执，回执查询失败不会触发再次启动。使用 `:abort` 取消；`aborted: false` 且 admission 为 `held` 表示取消仍待核对，`cancelled` 才确认取消。要修改已保存请求，应先取消，再使用新 ID 提交。

外部执行器的立即投递结果未知时，待发送队列会保持恢复确认状态，活跃轮次结束也不会自动启动。`:resume` 会保留请求的 `held` 状态并返回说明错误，不会重复该外部动作。先核对执行器的实际结果，再显式发送或取消保留的提示词。

提交提示词后若响应丢失，重试时保持可选的 `prompt_id` 和完整请求体不变。匹配的重试返回原受理回执，不会重复提交，main agent、附件和内嵌 Skill 提交也遵循此规则。输入改变时须使用新 `prompt_id`；复用已受理 ID 携带不同输入会返回 `40938`。较早的受理请求若没有可重放回执，应检查队列或历史，不要自动再次发送。

提示词可在顶层 `execution` 携带同一份 [execution 选择](#会话)。选择随该提示词保存，到启动时才应用，而不是入队就生效；当前轮次保持已提交的绑定。execution 代际变化时新建远端会话，不恢复或 fork 旧远端，也不发送旧 Kiki 对话的交接文本；Kiki 中可见的历史仍保留。冷恢复继续使用已提交的代际及其自身保存的远端引用。

顶层 `profile`、`model` 与 `thinking` 选择也随提示词保存。与 `model` 一起携带 `model_switch_mode: "direct" | "compact" | "fresh"`，即可将已确认的上下文选择附在同一条消息上：保留当前上下文、先生成摘要，或重建新的上下文窗口。该选择不能同时改变 `profile` 或 `execution`。提示词列表项通过可选的 `runtime_controls` 返回保存的设置，其中模式使用 camelCase `modelSwitchMode`。队列恢复后设置仍保留，不会创建独立的控制队列项；保存的选择或受理回执都不证明真实请求已使用目标模型。

要立即发送新消息，在提交正文中加入 `delivery_mode: "steer"`；省略则保持普通发送。选择持久受理时，服务端会保存这一意图，并在返回 `restoring` 后继续投递，客户端断开也不影响。目标是请求到达时正在运行的轮次；若它在受理前结束、另一轮已经启动，消息仍排队等待独立轮次，不会插入后来的轮次。没有活跃轮次时，沿用原有的新轮次启动路径。需要独立轮次的 profile、execution 或运行控制变更仍保留在队列中。

立即发送会在安全步骤边界把普通选中提示词追加到活跃轮次。原生提示词携带模型、思考强度或上下文选择时，会在当前模型响应与工具结果完整落入历史后应用选择，随后消费同一条消息一次。绑定提交前取消或摘要失败不会改变绑定与上下文，也不会用旧模型发送该消息。不支持的外部上下文重建会失败，不会悄悄变成直接切换。main agent 的前台子任务等待可以转入后台，子任务不会被取消。

仅当消息明确依赖已有的显式切换操作时，使用 `after_model_switch`。不要同时携带新的模型、思考强度、profile、execution 或上下文选择：服务端会拒绝混合选择，不会静默换成旧依赖的绑定。独立的手动压缩通过 `compaction.started`、`compaction.completed` 或 `compaction.cancelled` 报告自身进度；它不会受理或执行待发送消息的模型选择。

独立的原生模型切换会在下一次模型请求前应用，无需提交提示词，也不会中断当前请求。其 `thinking` 输入可用字符串显式指定力度，用 `null` 恢复 persona、model-profile 或模型默认力度，省略则保留当前力度。

对于显式切换操作，受理发送不表示切换已完成。切换失败或持久化完成状态不确定时，原消息仍保留在队列中，切换显示可恢复的状态；按同一操作重试即可继续已受理的投递，已取消的切换不会被重新启用。与模型切换无关的 execution 选择仍须独立启动轮次。重启后，立即发送只让选中项绕过恢复确认，其他恢复的提示词仍等待确认。中止已追加的提示词会取消它所加入的轮次，不会取消后续轮次。普通 `:abort` 对不存在或已经结束的提示词返回 `40402`；从队列移除条目时使用 `?queued_only=true`。

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

Kiki 根据 OpenSSH 配置和路径展开结果确定 `UserKnownHostsFile` 的路径边界，支持多个文件和用引号包围的含空格路径。无法唯一确定边界时，请求失败，不会猜测。`UserKnownHostsFile none` 返回空的 `files` 列表，也不会写入默认文件；未知密钥仍需在每次连接时审批。此 API 不连接主机、不修改信任记录，也无法判断远端密钥未变或已变化。首次密钥审批和变化后拒绝连接仍由既有连接流程处理。

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

`PUT` 使用与 GUI 相同的判别联合请求体。`type` 为 `agent-browser-profile` 时必须给出 `name`，可带 `profilePath`、`executablePath`、`headed`、`driverPath`；`type` 为 `agent-browser-cdp` 时必须给出 `name` 与 `endpoint`，`endpoint` 取值为 `{ "action": "set", "value": "<CDP 的 http 或 ws 地址>" }`，或 `{ "action": "keep" }` 表示保留已存地址。两者都可带 `enabled`，默认 `true`。新建 CDP 连接时未提供 `set` 会被拒绝。已保存的 CDP 地址读回时是掩码；显式读取需用 `POST /api/secrets:reveal`，其 `ref` 的 `kind` 为 `"browser_endpoint"`。`type` 为 `ego-lite` 时必须给出 `name`，可带可选的 `cliPath`、`profileId` 和 `serverName`，没有 endpoint。

`kimi-webbridge` 请求体必须给出 `name`，可带 `enabled` 和可选的 `driverPath`，不接受 `endpoint`。它使用服务器本机 `http://127.0.0.1:10086` 的 Kimi HTTP 桥，不启动 CDP 驱动。扩展已运行不会自动注册 Kiki 连接：若 `BrowserConnections` 或 REST API 对此 id 报 `browser.not_found`，先在浏览器控制设置或 `config.toml` 保存 `kimi-webbridge` 类型连接，再检查该连接。旧版保存为 CDP、且 id 恰为 `kimi-webbridge` 的条目默认也走这条 HTTP 路由，但不改写保存的类型；见 [`webbridge_preset_route`](../configuration/config-files.md#browser-control)。其他 CDP id 保持原路由。

`webbridge-command` 请求体必须给出 `name`，可带 `enabled`（默认 `true`），不接受 `endpoint` 或 `driverPath`。它向固定的本地 `/command` 端点发送扩展命令，不启动 agent-browser。工具目录返回 `contextIsolation: "extension-command-session"`。每个调用方使用独立的命令会话；标签身份为 `wb:<十进制 id>`，不是 DevTools target ID。页面操作、选择与关闭只能作用于该调用方最近一次 navigate 打开的标签。Kiki 不会按 URL 查找另一个标签，同 URL 的两个标签也不会混选。不支持 window 和 frame 方法。断开连接只释放 Kiki 的绑定，不关闭标签；显式的 `agent_browser_end_session` 页面操作会关闭该调用方的命令会话。

既有 `kimi-webbridge` HTTP 桥的工具目录返回 `contextIsolation: "main-frame-only"`：不支持新建窗口或操作非主 frame。选择标签时使用列表返回的准确 id，并核对实际选中的 id；重复 URL 导致目标不唯一时，会拒绝切换到另一标签。已保存的连接若本机 HTTP 状态无法读取、守护程序报告停止，或扩展报告断线，会返回 `state: "disconnected"`、`failure.code: "browser.disconnected"` 和对应原因；恢复后再次 `:check` 会清除这一失败；若连接尚未附着，则返回 `idle`，需要先连接再列出标签。命令已发出、但应答丢失或无法读取时，状态为 `unconfirmed`，`failure.reason` 为 `"outcome_unknown"`，不会重放命令。`:check` 只检查桥的健康状态；未确认命令后返回 `idle` 时，先重新连接、选择标签并观察，再决定下一步动作。明确的否定应答则记为已结束的 `failed` 结果。

执行类动作失败即关闭：未开启 `native_browser` 实验开关时，`:connect` 返回信封码 `40001`，`details.code` 为 `"browser.disabled"`、`details.reason` 为 `"feature_disabled"`；连接自身被停用时返回的 `details.reason` 为 `"connection_disabled"`。Klient 对应方法为 `rest.browser.list()`、`upsert(id, input)`、`remove(id)`、`setDefault(browser?)`、`status(id)`、`tabs(id)`、`catalog(id, { includeSchema })`、`check(id)`、`connect(id)` 和 `disconnect(id)`。

### 浏览器引导预设

预设为 `kimi-webbridge`、`independent-browser`、`codex-browser` 和 `ego-lite`。`kimi-webbridge` 与 `independent-browser` 管理本地组件，而 `codex-browser` 将匹配的端点名称列为尚未验证的候选项（`candidates`，最多 20 项），并保存明确选定的管道。桌面应用工具也使用同一名称前缀，因此发现名称不代表扩展连接已验证；仅凭空列表也不能判断扩展未启用。Kiki 不安装外部应用。`kimi-webbridge` 的连接与打开都指向一条固定的本地桥，不接受候选列表。扩展探测成功后，若 id 空闲，会新建不带 endpoint 的 `webbridge-command` 连接，返回 `connectionId: "webbridge-command"` 及 `connection` 运行状态。若该 id 已被另一类型占用，会返回 `reason: "connection_conflict"`，不替换该条目，也不覆盖既有 `kimi-webbridge` 连接。Codex 管道和独立浏览器 profile 是另外的接法，不会因此多出 Kimi WebBridge 实例。

`ego-lite` 的 `controlSurface` 为 `"external-app"`，`sourceUrl` 为 `https://lite.ego.app/download?auto=1`。状态查询共享一次后台检测。检测中，GET 返回 `state: "preparing"`、`reason: "ego_detecting"`，以及状态为 `running` 的 `detect` 步骤；其他预设仍可读取。再次轮询即可取得结果。发现过程与自动 CLI 检查共用五秒期限；超时返回 `failed`、`reason: "ego_detection_failed"` 和具体错误。结果从完成时起保鲜 30 秒。`:cancel` 停止当前检测；关闭该来源也会停止检测，不改浏览器权限。

已保存的 Ego 连接或可识别的 Citro 安装路径可以通过 `nodejs` 自动检查；仅从 PATH 找到的其他可执行文件需要显式检查。只有检查输出包含 `kiki-ego-ready` 时才是 `ready`。其余原因是 `ego_installed`、`ego_onboarding` 和 `ego_choose_cli`。该预设的 `:prepare` 会被拒绝。`:connect` 执行检查；成功且尚无该 id 时，保存连接 id `ego-lite`，不改允许列表，也不改默认浏览器。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/browser/setup` | 列出预设、步骤状态及可用操作 |
| `GET /api/browser/setup/{preset}` | 读取单个预设的状态 |
| `POST /api/browser/setup/{preset}:prepare` | 以 `{ "consent": true }` 确认安装组件 |
| `POST /api/browser/setup/{preset}:connect` | 连接已配置的预设或保存选定的候选管道 |
| `POST /api/browser/setup/{preset}:open` | 打开或激活独立浏览器窗口；WebBridge 预设则连接桥接程序 |
| `POST /api/browser/setup/{preset}:update` | 从经过校验的下载更新组件，失败保留原安装 |
| `POST /api/browser/setup/{preset}:shortcut` | 在 Windows 服务机桌面创建独立浏览器快捷方式 |
| `POST /api/browser/setup/{preset}:cancel` | 取消配置 |

`:connect` 接受可选的 `connectionId`（稳定连接 ID）、`browserId`（所选管道标识符，例如 `codex-browser-use-...`）、`name` 与 `setDefault`；`:open` 接受可选的 `connectionId`；`:shortcut` 接受可选的 `connectionId` 和快捷方式名称 `name`；`:update` 使用空对象。所有操作返回配置状态，应读取 `state`、`reason`、`error`、`steps`、`actions`、`candidates` 以及已保存的 `browserId`，而非仅凭 HTTP 成功判断操作完成。保存候选管道后返回 `state: "needs_user_action"` 与 `reason: "approval_unproven"`，表示目标已配置，但浏览器握手尚未验证。保存不会打开管道或消费权限请求。只有浏览器控制服务确认握手后，预设才进入 `connected`；连接失败仍保留错误。真正的权限请求仍交给当前权限处理方。已停用的连接返回 `connection_disabled`，不会改用其他 profile；窗口激活失败返回 `state: "failed"`。

更新只替换磁盘上的文件，不切换已运行的浏览器或桥接程序。`reason: "disk_updated"` 表示磁盘文件已更新；`"disk_updated_running_unchanged"` 还明确表示正在运行的 WebBridge 程序未切换。两者均不表示运行中的进程已升级。

Klient 对应方法为 `rest.browser.setupPresets()`、`setupStatus(preset)`、`prepare(preset, { consent })`、`connectPreset(preset, input?)`、`openPreset(preset, input?)`、`updatePreset(preset, input?)`、`createShortcut(preset, input?)` 和 `cancelSetup(preset)`。

### 终端

PTY 终端接口，仅 loopback 绑定时挂载。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/sessions/{session_id}/terminals` | 列出终端 |
| `POST /api/sessions/{session_id}/terminals` | 创建终端 |
| `GET /api/sessions/{session_id}/terminals/{terminal_id}` | 读取终端（含回滚缓冲） |
| `POST /api/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭终端 |

### 工作区

选择工作区和修改名称、置顶状态时使用 catalog 视图；需要会话数或 Git 状态时，再读取目标工作区的详情。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/workspaces?view=catalog` | 列出已持久化的注册信息，不等待会话计数、Git 检查或旧目录发现 |
| `GET /api/workspaces` | 列出完整工作区记录，等待目录发现及每个工作区的会话计数、Git 检查 |
| `GET /api/workspaces/{workspace_id}` | 读取一个已注册工作区及其会话数、Git 状态，不做全局目录发现 |
| `POST /api/workspaces` | 注册工作区（按根路径幂等），返回完整记录 |
| `PATCH /api/workspaces/{workspace_id}?view=catalog` | 重命名和／或置顶，只返回保存后的注册信息 |
| `PATCH /api/workspaces/{workspace_id}` | 重命名和／或置顶，返回含会话数、Git 状态的完整记录 |
| `DELETE /api/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/workspaces/{workspace_id}/trust` | 读取信任状态，不启动工作区运行时 |
| `POST /api/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/workspaces/{workspace_id}/untrust` | 撤销信任 |

两种列表都返回 `{ items }`。Catalog 条目只有 `id`、`root`、`name`、`created_at`、`last_opened_at` 和 `pinned`；缺少 `session_count`、`isGit` 表示尚未测量，不代表零和 false。Catalog 只读取已持久化的注册项；明确需要发现旧工作区目录时，使用默认完整列表。客户端应将这两种响应分别缓存。

两种 `PATCH` 都接受 `{ name?, pinned? }`，至少提供一个字段。Catalog 形式保存并返回注册信息，不等待目录发现、计数或 Git。单个工作区详情按同根目录的注册 ID 和旧目录别名统计会话（含归档），只检查该根目录的 Git。这些测量仍可能耗时或失败，应与工作区选择、名称和置顶编辑分开加载。详情或 catalog `PATCH` 的注册 ID 不存在时，返回信封码 `40410`。

### 记忆

`{scope}` 取 `global`、`workspace`、`persona` 或 `persona_workspace`。三个非全局范围需要在查询串里带归属：工作区带 `workspace_id`，角色带 `persona_id`，角色的单工作区笔记两个都要。未知 `workspace_id` 会被拒绝。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/memory/settings` | 读取记忆配置，含 `effective_enabled`、可选 `advisor` 及 `advisor_status`；可选 `workspace_id` 用于判断该工作区的有效记忆访问设置 |
| `PATCH /api/memory/settings` | 修改 `enabled`、`approval`、`budget` 或稀疏 `advisor` 字段；接受同一可选 `workspace_id` |
| `POST /api/memory/advisor/probe` | 用虚构内容测试已保存的顾问来源；请求体为 `{ confirm_destination }` |
| `GET /api/memory/advisor/status` | 用 `session_id` 和可选 `agent_id`（默认 `main`）读取 live Agent 状态；冷会话或不存在的 Agent 返回 `null` |
| `GET /api/memory/workspaces/{workspace_id}/settings` | 读取某个工作区的开关 |
| `PATCH /api/memory/workspaces/{workspace_id}/settings` | 设为 `true` / `false`，或 `null` 表示跟随全局 |
| `GET /api/memory/{scope}` | 搜索或列出条目，过滤与分页见下文 |
| `GET /api/memory/{scope}/{id}` | 读取单条，带 `target`、`applicability` 和 `complete` |
| `PUT /api/memory/{scope}/{id}` | 写入条目；`{id}` 传 `new` 表示新建 |
| `DELETE /api/memory/{scope}/{id}` | 删除条目（`expected_revision` 放查询串） |
| `GET /api/memory/{scope}/inbox` | 列出待审提议 |
| `GET /api/memory/{scope}/journal` | 改动历史，可用 `id` 收窄到单条 |
| `POST /api/memory/{scope}/undo` | 按 `operation_id` 撤销一次操作 |
| `GET /api/memory/authority` | 读取持久化的后端、模式、epoch 与迁移进度 |
| `POST /api/memory/authority/retry` | 用已保存的操作 ID 重试启动迁移 |
| `POST /api/memory/authority/migrate` | 单批有界迁移的兼容入口 |
| `POST /api/memory/authority/cancel` | 取消匹配的暂停维护批次 |
| `POST /api/memory/authority/recover-readonly` | 保存受治理恢复包，进入只读模式 |
| `POST /api/memory/authority/resume-editing` | 用当前恢复 ID 与 epoch 恢复 SQLite 编辑 |
| `POST /api/memory/{scope}/forget-preview` | 将精确 ID 展开为完整来源链目标集合 |
| `POST /api/memory/{scope}/forget` | 不可逆地忘记已确认的目标集合 |
| `GET /api/memory/{scope}/{id}/provenance` | 读取原始来源、人工裁决与关联 ID |
| `GET /api/memory/{scope}/{id}/revisions/{revision}` | 读取精确历史版本；revision 需 URL 编码 |
| `GET /api/memory/{scope}/{id}/export` | 导出单条完整、绑定版本的 Markdown 文档及条目 |
| `POST /api/memory/{scope}/import-preview` | 比较 Markdown 文档与当前受治理条目 |
| `POST /api/memory/{scope}/import` | 应用明确确认过的预览 token |

将 `advisor.source` 设为[决策来源](#决策连接)，优先于已有 `selector`。稀疏 `{ "advisor": { "mode": "off" } }` 保留来源及其他设置。`mode` 取 `off`、`rank` 或 `select`；`pair_score` 只支持 `rank`。`advisor: null` 删除整个配置块；`source: null` 同时清除来源和旧 selector，`selector: null` 则只清除 selector。修改无需重启即可生效。

旧选择器仍为 `{ protocol: "chat_json" | "system_one" | "pair_score", model, endpoint? }`，`model` 是已配置 alias，非对话协议的 `endpoint` 须与该模型的 `effective_base_url` 同源。新的连接来源将协议及端点保存在连接上。

配置来源并开启顾问后，即使用该服务推荐。旧的 `advisor.egress_ack` 值仍可读取和保留，但不再作为请求门槛；`advisor_status.consent_required` 为 `false`。更换目的地会取消尚未完成的推荐，使用新服务重新计算。配置步骤见[记忆顾问](../guides/memory.md#记忆顾问)。

探针的 `confirm_destination` 须匹配当前 `advisor_status.destination`，将本次测试请求绑定到该服务。探针不读取已存条目，自动推荐关闭时也可测试。返回 `{ ok, status, duration_ms, input_tokens?, output_tokens?, usage_known }`。

状态包含 `state`、可选 `reason`、目的地及模型，以及逻辑轮数 `logical_calls`、实际请求 `requests`、重试 `retries`、推荐数 `recommended_count`、目录覆盖 `enumeration`、未判断数 `unjudged_count` 和挤出条目 `displaced_ids`。设置状态说明配置是否就绪；`/advisor/status` 读取实际运行结果，不会启动或恢复 Agent。

`GET /api/memory/{scope}` 返回有界分页的 `{ items, mode, next_cursor, coverage }`，不带分页参数时也一样。没有 `query` 时 `mode` 默认 `list`，有 `query` 时默认 `search`；`page_size` 取 1–20。没有显式 `statuses` 时，list 查 `active` 和 `pending`，search 查 `active`，`include_inactive=true` 把两者都放宽到四种。`statuses` 是 `active`、`pending`、`superseded`、`archived` 的逗号串。既有客户端必须消费 `next_cursor`，不能把第一页当成整个命名空间。

持续接续，直到 `next_cursor` 为 null 且 `coverage.exhausted` 为 true。带 cursor 的空准备页不代表命名空间为空。`coverage.complete` 和 `warnings` 说明不可读、非法或过大的记录；这些记录不会隐藏其余可读条目。扫描预算限制单次调用，不永久限制清单大小。文件后端针对每个有界源片段排序；SQLite 各页共享同一已提交版本。

续读保持同一个 `{scope}` 路径和归属的 `workspace_id` / `persona_id`，只传 `cursor`，不要再带原过滤条件或页大小，混传会返回 `40944`。文件后端源内容变化或 store 重启会让 cursor 失效；重新查询并按范围加 ID 对账。SQLite 续页在后续写入发生后仍保留原提交视图，同时重新核对范围访问权限与遗忘屏障。`GET /api/memory/{scope}/inbox` 为 `pending` 返回同样的分页形状，接受 `page_size` 或 pending 列表的 `cursor`；其他状态或 search 模式的 cursor 会被拒绝。

`PUT /api/memory/{scope}/{id}` 使用与 [`MemoryWrite`](../reference/tools.md#写入一条条目)相同的动作词表：`action`（`create`、`update`、`supersede`、`archive`）、`type`、`title`、`body`、`reason`、`expected_revision` 和 `pinned`。经 REST 的写入一律记录为来自你，无论 Agent 本会用哪个 `source`。响应是 `{ entry, operationId, outcome, warnings? }`，`outcome` 取 `applied`、`pending` 或 `unchanged`；`unchanged` 以及与已在等待的提议完全相同的重复提交，`operationId` 为 `null`，这两种情况都没有可撤销的操作。`update`、`supersede` 和 `archive` 必须带 `expected_revision`——基于过期版本的 `PUT` 会被拒绝，而不是覆盖掉更新的那一版。

两个元数据字段可选，且「省略」的含义不同：

- **`basis`**——`{ kind, note, refs? }`，`kind` 取 `human`、`observed`、`derived`、`unknown`。它是对象或缺省，永远不是 `null`。`update` 时省略它，只有在 `type`、`title`、`body` 都没变的情况下才保留原依据；改了其中任何一项却没给新依据，这条记忆会降为 `{ kind: 'unknown' }`，并在 `warnings` 里说明依据没有刷新。
- **`validity`**——`{ check, until? }`，`null` 是有意义的：它清除已记录的核对项。`update` 时省略整个 key 表示保留原值，新建条目省略则表示没有记录。没有记录有效性的条目不等于永远有效。

`covered_by` 只在 `archive` 时接受，填同一范围内保留的生效条目的 `{ id, expected_revision }`。存下来的条目以 `{ id, revision }` 记录同一依赖——就是你发过去的那个 revision——并且在真正执行归档时会重新核验，所以对着已经变了的替代条目归档会失败，而不是丢掉仍然需要的规则。

`GET /api/memory/{scope}/{id}` 返回完整条目，外加 `scope`、取 `{ scope, id, expected_revision }` 的 `target`、取 `expired` / `recheck` / `unrecorded` 的 `applicability`，以及 `complete: true`。`target` 是用来定位的对象，不是请求体：`scope` 和 `id` 放路径上，归属的工作区或角色放查询串上，`PUT` 请求体里只有 `expected_revision` 这一个字段取自它，其余是你这次要写的 `action`、`type`、`title`、`body` 和 `reason`。写之前先读：`expected_revision` 对不上的 `PUT` 会返回 `40944`，响应的 `details` 带着 domain 自己的 `code` 与 `recovery`，而信封里的数值 code 仍是既有客户端已在处理的那一个。

#### Markdown 导出与导入

这三个路由要求已完成 SQLite 迁移，归属查询参数与普通条目读取相同。即使 Agent 的记忆访问已关闭，仍可用于显式管理。只读恢复模式允许导出，但拒绝预览和导入。

`GET /api/memory/{scope}/{id}/export` 在通常的信封中返回 `{ markdown, entry }`。`markdown` 是完整的 `kiki-memory-v1` 文档，由 JSON 或 YAML Frontmatter 加完整正文组成。编辑已有条目时，保留 `format`、`scope`、`id`、`revision`、`origin: { id, revision }` 与来源坐标。真正的新文档使用 `id: "new"`、`revision: null`、`origin: null` 和 `status: "active"`。文件还包含 `type`、`title`、`status`、`pinned`、可选的 `basis` 与 `validity`。这一完整文档格式与部分更新的 `PUT` 不同：`validity: null` 或省略 `validity` 都会清除复核条件。正文上限仍为 1,500 字符。

向 `POST /api/memory/{scope}/import-preview` 发送 `{ markdown, source_locator, reason }`。使用稳定的源文件定位；服务会将其记为来源，不会据此获取文件。完整文档上限为 65,536 个 UTF-16 代码单元，定位上限为 2,000 字符，理由上限为 500 字符。请求中未定义的字段会被拒绝。响应使用 camelCase 字段：

- **`incoming`、`current`**：完整解析后的文档及当前受治理条目；新目标的 `current` 为 `null`。确认前核对两者。
- **`action`**：`create`、`update`、`unchanged` 或 `retained`。`unchanged` 无需写入；`retained` 将已接收来源指向其当前条目，不重放旧内容。
- **`canApply`、`issue`**：只有 `canApply: true` 才可确认。被阻止的预览可含 `issue: { code, recovery }`，说明版本过期、标题重复或目标未生效等问题。
- **`previewToken`、`expiresAt`**：可确认的预览才返回。这一 token 将完整的已审载荷绑定到当前服务进程与存储权威 epoch，十分钟内有效。

确认时，向 `POST /api/memory/{scope}/import` 发送 `{ preview_token: previewToken, operation_id: UUID, confirm_import: true }`，保持相同范围归属，不重新提交或拼装编辑后的文档。成功返回通常的 `{ entry, operationId, outcome, warnings? }` 写入结果；这次导入记为你的写入，同时保留原始 Markdown 来源。

服务在应用时重新核验目标版本与来源屏障。并发编辑或遗忘不能被覆盖；版本冲突返回 `40944` 及 domain 详情。过期、篡改或重启前的 token 返回 `40001`；token 失效或存储权威状态变化后，保留原文件重新预览。版本冲突时，若条目仍存在，重新导出、合并修改后再次预览；若已遗忘，停止导入这份旧来源。给旧文件换 ID、标题或定位不会重新启用已纠正或遗忘的来源。导入不能批准待审提议、恢复已退出条目或跨范围移动条目；请先使用通常的审批或恢复操作。

#### 后端迁移与恢复

App 启动自动执行已有 SQLite 迁移流程，新家目录和 `memory.enabled=false` 的家目录也一样。普通 Memory store 的准备、读取和写入共享这次启动操作。已完成的家目录复用 SQLite，不重复导入；只读恢复状态保持只读。存储升级不会开启 Agent 记忆访问，也不会授权顾问外发。

`GET authority` 返回 `backend`、`mode`、`epoch` 和持久化的 `migration`。迁移期间，`migration.id` 是操作 ID，`namespaces` 列出发现的范围，`index` 是已完成的命名空间数，可选 `after` 是当前命名空间最后提交的来源 key。可选 `phase` 取 `importing`、`validating` 或 `failed`；`issues` 含 `{ scope, key, issue }`，`failure` 提供 `{ code, message }`。来源无效时保留原文件、阻止普通记忆访问，不会退回过时副本。修复报告的来源后，向 `authority/retry` 发送 `{ operation_id: migration.id }`，或重启后继续同一操作。回执不确定时先读状态，再决定是否重试。完成时返回 `backend: "sqlite", mode: "active", migrationId`；同 ID 重试也能对账已经完成的操作。

兼容入口 `authority/migrate` 仍接受 `{ operation_id: UUID, max_pages?: 1..64 }` 执行有界维护批次，默认八页。旧字段 `older_writers_stopped: true` 已可省略，启动流程不会发送它。`authority/cancel` 接受 `{ operation_id }` 取消暂停的批次，不取消正在运行的自动操作；之后正常准备存储时会再次自动升级。共用家目录的其他安装也应升级：标记和写屏障约束支持协议的写入进程，无法约束协议发布前的旧二进制。

向 `authority/recover-readonly` 发送 `{ confirm_readonly: true }`，将当前受治理 SQLite 数据库、旧格式的当前视图导出及 manifest 保存到 `store/memory-recovery-v1/<recoveryId>`。响应含 `recoveryId`、`scope`、`generation`、`namespaces` 与 `mode: "readonly"`。读取继续使用 SQLite，修改被拒绝。恢复正常编辑时，先读 `authority`，再向 `authority/resume-editing` 发送 `{ recovery_id: recoveryId, expected_epoch: epoch }`；恢复 ID 或 epoch 已变化时会拒绝。完整数据库保留切换后的操作、纠错、提案和遗忘屏障，Markdown 导出只表达兼容的当前视图。

#### 不可逆遗忘与历史读取

完成 SQLite 迁移后，向 `{scope}/forget-preview` 发送 `{ ids: ["m_example"] }`。响应 `{ generation, targets }` 展开完整来源链，每个目标含 `id`、`expectedRevision` 和当前 `entry`；可恢复删除的对象为 `entry: null`。确认前向用户显示这个精确集合。再向 `{scope}/forget` 提交 `{ operation_id: UUID, confirm_irreversible: true, targets: [{ id, expected_revision }] }`，将预览中的版本逐项填入 `expected_revision`。版本变化或来源链不全时会拒绝。该操作不可撤销，不删除对话历史、外部源文件或独立持有的备份。

精确历史读取返回带 `historical: true` 的条目，不代表现行指引。已遗忘的历史版本与当前条目都返回未找到。恢复旧备份前，须保留最新适用的人工裁决和遗忘屏障，避免重新引入已退出的内容。

### 会话租约与 peer thread

会话租约（lease）是客户端持有的、需定期续期的「在线凭证」：`POST /api/leases` 创建或续期一条租约（默认有效期 60 秒），响应返回 `lease_id` 与 `expires_at`。持有租约可以挂住需要清理的资源（如 PTY 终端与文件监听），并让共享 daemon 在空闲退出判定时保持运行，见 [`kiki serve`](../reference/command.md#kiki-serve) 的 `--idle-exit`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/leases` | 创建或续期租约（body 为可选的 `lease_id`），返回 `lease_id` 与 `expires_at` |

peer thread 接口用于跨会话协作：以 `{ host_id, workspace_id, session_id }` 三元组定位同一台本地主机上的其他会话，读取其已完成轮次或投递消息。工具侧对应 `ThreadList` / `ThreadRead` / `ThreadSend` / `ThreadWait`，概念介绍见 [Agent 与子 Agent](../customization/agents-and-subagents.md#peer-thread-通信)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/threads` | 列出可寻址的 thread，可按 `workspace_id` 过滤，游标分页 |
| `POST /api/threads:read` | 读取一个 thread 已完成的轮次，保留其记录的来源，可带 `cursor` 续读 |
| `POST /api/threads:send` | 向另一个 thread 持久投递一条消息（需非空 `idempotency_key`，同一 key 只对应同一条消息） |
| `POST /api/threads:wait` | 长轮询等待至多 8 条 thread 的活动，`timeout_ms` 最长 60 秒 |
| `GET /api/workspaces/{workspace_id}/thread-communication` | 读取该工作区 peer thread 通信的持久化覆盖值与生效状态 |
| `PUT /api/workspaces/{workspace_id}/thread-communication` | 持久化该工作区的启用 / 禁用覆盖值 |
| `DELETE /api/workspaces/{workspace_id}/thread-communication` | 清除覆盖值 |

#### ThreadRead 续读

本地历史投影准备期间，`POST /api/threads:read` 可能返回 `turns: []`、`incomplete: "history_preparing"` 和不透明的 `next_cursor`。这是准备未完成的页面，不是 thread 没有对话的证明。请保留同一 thread 和 bridge 范围，用 `next_cursor` 重复请求。准备游标会绑定投影代次和固定的源水位，同时保留原先的较旧轮次边界；准备完成后，已结束轮次仍使用原有默认 `limit` 20、范围 1–100 和按时间顺序返回。

本地轮次的 `input` 和 `output` 字段在不超过 4,096 个 UTF-16 代码单元时直接完整返回。更长的字段返回预览，并在 `content_refs` 中提供对应字段的续读引用。保留同一 thread，将该引用作为 `content_ref` 发送，即可获得 `view.segment`；保留预览，依次追加各段的 `value`，沿 `next` 续读，直到没有 `next`。每段最多包含 16,384 个 UTF-16 代码单元，引用从已返回文本之后开始。分段读取不会恢复该 thread 的执行。

旧版 read cursor 仍为兼容而接受。历史重写会明确使受影响的游标失效，代次变化也会使游标失效；服务端报告游标无效时，应从首页重新读取，不能把 thread 当作空历史。

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

Peer 消息不再受邮箱原来的 512 条淘汰上限影响。[消息邮箱存储升级](#消息邮箱存储升级)会在切换前回填旧邮箱中仍保留的记录；旧版本已经淘汰的消息不会从会话 wire 重建。用 Kiki 0.5.x 打开该 home 前，先关闭旧 writer 并完成升级。

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
| `POST /api/fs:media-preview` | 创建本机音视频临时播放链接（已认证的回环连接） |
| `DELETE /api/fs:media-preview/{preview_id}` | 撤销本机媒体播放链接（需要 bearer token） |
| `POST /api/sessions/{session_id}/media-playback` | 为会话内 canonical 音视频文件创建临时播放链接（已认证的回环连接） |
| `DELETE /api/sessions/media-playback/{preview_id}` | 撤销会话播放链接（需要 bearer token） |
| `GET /media-preview/{preview_id}` | 读取链接授权的本机文件或会话 canonical 文件，无需 bearer 请求头，支持 Range 分段 |

预览本机音视频时，向 `POST /api/fs:media-preview` 发送 `{ "path": "<文件绝对路径>" }`。响应信封包含 `preview_id`、`url`、`mime`、`size` 和 `expires_at`（Unix 毫秒时间戳）。将 `url` 直接交给媒体元素；持有该链接即可读取对应文件，直到 30 分钟后过期、被撤销或服务停止。关闭预览时调用 `DELETE /api/fs:media-preview/{preview_id}`。这些路由只在服务开启认证时注册；创建链接要求客户端地址及主机名均为回环地址，同时最多保留 64 个链接。本机创建接口只接受绝对路径，不接受会话媒体 ID。历史附件向 `POST /api/sessions/{session_id}/media-playback` 发送 `{ "file_id": "<canonical 文件 ID>" }`。响应字段相同，`GET /media-preview/{preview_id}` 按该 canonical 文件分段读取。这个请求里的本机路径会被拒绝；找不到 canonical 文件时不会改读本机路径。用 `DELETE /api/sessions/media-playback/{preview_id}` 撤销。无法满足的 Range 返回 416。本机和会话链接共用回环、30 分钟和 64 个链接的限制。这些 media-preview 路由负责这张共享表：30 分钟后过期，DELETE 删除，服务停止时清空。保存为 `tool-result.bin` 且类型为 `application/octet-stream` 的工具结果，只有前 512 字节能识别为音频或视频时才可播放；已保存的字节和带认证下载的通用二进制类型保持不变。活跃会话的 lease 在播放结束、客户端断开或流失败时释放一次；释放失败会报告，不会被丢掉。可播放的编解码格式仍由浏览器或 WebView 决定。其它读取仍走带认证的 `GET /api/sessions/{session_id}/media/{file_id}`。

会话 `fs:{action}` 工作区 API 只接受工作区相对路径，拒绝绝对路径及符号链接逃逸。这条 GUI 边界不限制另一路 Agent `Read` 工具显式指定的绝对路径。`/api/fs:content` 供已认证用户主动预览，不走 Agent 文件工具审批；不要泄露 bearer token，也不要在不可信网络上关闭认证。

会话与工作区的 `fs:search` 都按页返回，并限制每页遍历量。请求传入 `query`、`limit` 及可选的 `include_globs`、`exclude_globs`、`follow_gitignore`；续页时保持这些条件不变，将响应中的 `next_cursor` 作为 `cursor` 传入。响应包含 `items`、`sort_scope: "page"` 和 `truncated`，其中 `truncated` 当且仅当存在 `next_cursor` 时为 true。空页若带有 cursor，仍有待遍历内容；只在用户请求更多结果时续页，没有 cursor 才表示检索结束。

每页按分数降序、路径升序排列；空 query 只列出根目录，目录优先，再按路径排序。页内顺序不代表全局最佳匹配排名。query 改变或选择器关闭时取消请求；正在执行的文件系统调用结束后，取消会阻止后续遍历。单个超宽目录仍需完整读取并排序。若续页因条件或已遍历目录变化返回 `40001`，保留已显示的候选，并去掉 cursor 重新检索。

### 文件上传

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/files/{file_id}` | 删除 |

### IM 账号与信道绑定

[双向消息](../features/phone.md)将每个输入或输出信道绑定到明确的会话。角色可选；切换或清除角色不会迁移该会话的绑定。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/im/sessions` | 读取 policy、instances、discoveries、bindings、strangers 与 voice_fallbacks 快照 |
| `GET /api/im/sessions/catalog` | 可作为绑定目标的角色与会话 |
| `PUT /api/im/sessions/policy` | 设置 `allowed`、`default_enabled` 和可选的 `allow_channel_borrowing`（默认 `false`） |
| `POST /api/im/sessions/instances/{id}/listen` | 设置 `{ listening: true \| false }`；传 `true` 明确重试已停止的监听 |
| `POST /api/im/sessions/discoveries/{id}/confirm` | 绑定到 `target`；可选 `rebind`、`input_enabled`、`output_enabled`、`busy`、`reply`、`mobile_interactions`、`also_home` |
| `PATCH /api/im/sessions/bindings/{id}` | 修改这条绑定的目标、方向开关或选项 |
| `DELETE /api/im/sessions/bindings/{id}` | 移除这条 IM 绑定 |
| `GET /api/im/sessions/targets/{session_id}/channels` | 读取输出信道及候选，包含真实媒体能力 |
| `PUT /api/im/sessions/targets/{session_id}/notify/{channel_id}` | 用 `{ enabled: boolean }` 绑定单向通知输出，或调整其会话开关 |
| `DELETE /api/im/sessions/targets/{session_id}/notify/{channel_id}` | 只移除该会话的通知绑定 |
| `GET /api/sessions/{session_id}/optional-capabilities` | 读取含 `send_message` 的权威能力状态 |
| `POST /api/sessions/{session_id}/optional-capabilities` | 设置 `{ id: "send_message", choice: "on" \| "off" \| "inherit" }`，下一步热生效，无需重启 |

`target` 使用 `{ kind: "session", session_id }`；也保留 `{ kind: "persona", persona_id }`，作为绑定到该角色日常会话的快捷方式。PATCH 仍接受旧的 `session_id`，但它与 `target` 互斥；`also_home` 仅用于确认绑定。重新确认保留已有 `enabled`、`session_enabled`、`input_enabled` 和 `output_enabled`，除非请求明确修改。`session_enabled: null` 跟随 `policy.default_enabled`；方向设为 `null` 则删除该方向覆盖。入站、出站仍受绑定总开关与会话准入限制。

群聊确认和 PATCH 支持 `binding_scope: "sender" | "topic" | "chat"`；省略时只匹配原发送者。`topic_id: "0"` 表示没有话题：选 `"chat"` 绑定整群，选 `"sender"` 绑定原发送者；选 `"topic"` 返回业务码 `40001` / `topic_scope_unavailable`。非群聊选 `"topic"` 或 `"chat"` 返回 `40001` / `group_binding_scope_required`。已保存的无话题 `"topic"` 绑定仍只匹配原发送者，不会自动扩到整群。

PATCH 原位修改绑定。扩大范围与其他已启用入站绑定重叠时，须带 `rebind: true`；被拒绝或保存失败后，原绑定和待处理回复保持不变。显式打开连接不支持的方向返回 `40001` / `input_unsupported` 或 `output_unsupported`。这些错误在 HTTP 200 的 envelope 内；身份冲突使用业务码 `40949`。话题或群级绑定让成员共用会话，但保留真实发送者 ID，也不允许成员处理别人的待办交互。

新建的话题或群级绑定默认使用 `group_policy: { wake: "mention_or_reply" }`。确认和 PATCH 都接受 `group_policy: { wake: "always" | "mention_or_reply" | "manual", prefixes?: string[] }`：`always` 逐条唤醒；`mention_or_reply` 在真实 @、回复已知自身消息或命中配置的字面前缀时唤醒；`manual` 只记录、不唤醒。没有策略的旧发送者级绑定仍逐条唤醒。

@ 和回复识别依赖适配器提供真实元数据。内置 Telegram 提供真实消息 ID、时间戳、发送者和群名称、基于实体的 @ 与回复 ID；update ID 单独用于事件去重。未提供这些字段的其他传输可使用前缀或 `always`。

在「通知与消息」中选择群绑定的作用域和唤醒方式；REST 客户端可通过确认接口或 `PATCH /api/im/sessions/bindings/{id}` 修改。传输未提供 @／回复元数据时，可设置 `{ "group_policy": { "wake": "mention_or_reply", "prefixes": ["Kiki:"] } }` 使用前缀，或设置 `{ "group_policy": { "wake": "always" } }` 逐条唤醒。

已启用的群入站绑定按账号、群和话题保留有界持久时间线。静默消息不启动模型轮次。触发时，提示词会附带近期尚未消费的背景和最多四层引用祖先，并标记为不可信外部数据；提交获准后只推进本次捕获的背景水位，不删除时间线，也不丢失处理期间的新到消息。主 Agent 可用 [ReadMessageHistory](../reference/tools.md#im-聊天历史) 主动搜索本地记录，或显式读取可选的平台历史。关闭输入后，该绑定停止收集，也不再允许读取。

同一输入身份同时只归属一个会话。跨会话转绑未带 `rebind: true` 时，返回业务码 `40949`、`msg: "im_identity_already_bound"`，`details` 包含 `existing_binding_id`、`previous_session_id`、`target_session_id` 和 `variant_key`。显示这些身份供用户二次确认，再携带 `rebind: true` 重发请求；取消时不发修改请求。旧交互票据不会作用于新会话，旧回复监听在转绑时过期。手机端 `:target` 可列出目标，但转绑必须在 Kiki 中确认。缺少有效会话的旧绑定保留原身份与角色来源，显示 `pending_reanchor: true`，显式确认归属前暂停路由。

输出响应包含 `internal_enabled: true` 和 `channels`。每个信道含 `id`、`kind`（`internal`、`im`、`notify`）、`enabled`、`capabilities` 和可选 `bound`；`bound: false` 是候选，不是当前会话绑定。`internal` 常驻开启，旧内部信道开关接口拒绝 `{ enabled: false }`。Klient 方法为 `rest.imSessions.channelViews`、`setNotificationChannel` 和 `removeNotificationChannel`。

绑定信道不会授予 `SendMessage`。普通回复线程默认关闭；`[optionalCapabilities.defaults] send_message = true` 可改变全局默认，全局默认关闭时仍能通过会话 `on` 开启。角色消息模式保留隐式开启，显式会话 `off` 和工具策略硬拒绝优先。关闭工具既不解绑信道，也不隐藏普通最终回复。

工具获准后，省略 `channel`/`channels` 只发送到已绑且启用的输出，包含 `internal`；显式 ID 可点名一个或多个输出。借用未绑定信道要求 `allow_channel_borrowing: true`，且目标仍须启用并获授权。`to: "user"`、`to: "@Bot"` 与 Room 路由保留原收件人含义；信道 ID 不能与 Room 或 `@Bot` 路由混用。逐信道收据区分 `delivered`、`partial`、`unsupported`、`failed` 和 `unknown`，并标记借用目标。通知输出当前只承载文本。遇到部分成功或结果未知时先检查收据，不自动重发；供应商接受请求不等于收件人已收到消息。

实例的 `listening` 记录用户要求的监听状态。`adapter` 为 `missing`、`running`、`shared` 或 `stopped`；可选 `connection` 为 `starting`、`reconnecting`、`auth_expired` 或 `stopped`，正常运行时不填。`auth_expired` 需通过配置流程重新授权；连接停止后可明确重试监听。可选 `connection_detail` 含有限的 `code`（`transport_error`、`http_error`、`api_error`、`invalid_response`、`auth_expired`、`loop_failed`），以及可选数字 `http_status`、`ret`、`errcode`、`failure_count`、`retry_in_ms`。重连成功会清除该详情；缺少详情时不推断失败原因。

信道身份使用 `chat_id`、`sender_id` 与 `topic_id`（无话题时为 `"0"`）。可选 `chat_kind` 为 `private` 或 `group`；没有该字段时不从标题推断。当前微信连接只支持私聊联系人；确认群聊目标返回业务 `code: 40001`、`msg: "unsupported_wechat_group"`，保留发现记录，不创建角色日常会话或改动绑定。

若旧飞书话题绑定缺少回复上下文，由同一发送者在该话题发一条新消息，即可恢复仍待处理的审批与提问投递。不受支持的微信群绑定保持零发送；应停用或移除，而不是按私聊重试。单个绑定受阻不影响其他信道投递。

### 全局搜索与其他

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `POST /api/search/retry` | 内存压力导致索引器停止后重新启动它，并保留已发布的索引 |
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

`POST /api/search` 接受 `query`，默认搜索用户与 Assistant 正文及会话标题。设置 `include_tool_output: true` 才纳入工具结果和 Shell 输出，思考块、工具名称和工具输入始终排除。`role` 可选 `user`、`assistant`、`tool` 或 `title`，其中 `role: "tool"` 显式选择工具结果。相同内容范围适用于在线会话与已有索引；改变范围会使旧 `page_token` 失效，应去掉令牌重新查询。

`container.session_id` 指向在线会话时，搜索使用有界的驻留正文与共享历史导航投影。请求截止时间和客户端取消同时覆盖准备与匹配阶段。在线响应包含 `coverage: { domain: "full_text", complete, gaps, scanned: { bytes, records } }`。`incomplete: "scan_budget"` 表示扫描未完成或有历史被跳过，`incomplete: "deadline"` 表示时间或文本预算已用尽。部分页为空不等于没有匹配；`has_more` 为真时，使用 `page_token` 继续。续页复用已完成的准备，令牌在 60 秒后过期；令牌失效时应去掉它重新查询。`gaps` 也会说明页内排序和超出扫描额度的记录。部分结果的计数应显示为下限，即使已经没有可继续的令牌。

`POST /api/search/retry` 不需要请求体。索引器因连续内存压力停止后，调用它清除退避并重新启动已停止的索引写入。默认 SQLite 后端和 MiniDB 后端都适用。已发布索引中的文档仍可搜索；这次调用不删除、也不重建该索引。成功时沿用普通信封，`data.retried` 为 `true`。Klient 方法为 `rest.search.retry()`。

### 用量来源分组

`GET /api/usage` 支持 `dimension=agent|model|project|session|provider|profile`。原生 `provider` 与 `profile` 维度按每条记录保存的来源分组，包括同一个 Agent 切换智能体档、同一个模型别名切换供应商的情况。智能体档（Profile）指执行档，不是 persona，也不是 main/subagent 身份。

重复 `model`、`provider`、`profile`、`agent.id` 或 `workspace.id` 可选择多个值，例如 `?dimension=profile&profile=explore&profile=general`。同一个筛选字段内取 OR，不同字段间取 AND。`profile` 区分大小写、精确匹配记录的 `profileName`，不读取 Agent 当前档。响应在 `query.profiles` 中返回规范化的筛选值；旧服务器可能省略这个新增字段。

来源组使用不透明键，例如 `provider:"example-provider"` 或 `profile:"explore"`；缺失来源单独使用 `provider:null` 或 `profile:null`，对应归因字段为 `null`。这些记录保留已记录用量，不从模型或 Agent ID 猜来源。筛选值取 `group.provider` 或 `group.profile_name`，不要发送分组键。缺失来源没有筛选哨兵值；字面值 `unknown` 只匹配真实携带这个名称的记录。

查询所选时段或比较窗口时，发送 `range=custom&start_at=A&end_at=B`，边界为 epoch 毫秒的 `[A,B)`。概要、趋势分组与各会话的 `usage` 使用相同的记录筛选和精确窗口；会话金额不混入其他智能体档或时间桶余下部分。费用与 Token 的未知标记仍与已记录数字小计分别表达。分页令牌绑定筛选、数据版本和当前价格；任一项变化时返回业务码 `40922`。丢弃令牌并从第一页重新读取；GUI 会自动恢复。

### 会话累计用量

普通 `GET /api/sessions/{sessionId}` 返回上次发布的 `usage.accounting` 摘要；没有摘要时使用已保存的元数据，不扫描会话内的 Agent。刷新累计用量时，调用 `GET /api/usage/sessions/{sessionId}/accounting` 或 `klient.rest.sessionUsageAccounting(sessionId, { signal })`。该接口通过会话索引点读定位，不重新打开会话，并在普通成功信封的 `data` 中直接返回核算快照。会话不存在时返回业务码 `40401`。

快照包含 `tokens`、`tokens_unknown`、`cost_usd_estimated`、`cost_unknown`、`covered_at`（epoch 毫秒）、`source_revision`、`complete` 和 `freshness`。`complete` 表示来源覆盖完整；覆盖完成后，用量或价格仍可能未知。`freshness` 为 `current` 时表示最新一次核对分片，观察到变化或超过十分钟未核对后为 `stale`，没有已发布摘要时为 `unverified`；旧服务器可能省略此字段。摘要过期时仍可显示已知小计，不要把新鲜度当成完整性。

每次刷新最多推进十秒、100,000 条 wire 记录和 128 MiB 对话数据。`complete` 为假时，重复同一 GET 从已提交进度继续；同一会话的并发请求共享核算。客户端断开只取消本次等待，不中断该分片的发布。详情面板打开且页面可见时，GUI 对未完成或过期摘要每 250 毫秒续读，完整摘要每 15 秒刷新；需要时显示 "可能已过期" 或 "尚未核对"，摘要最新时不显示这行状态。

### 全量重扫用量统计

在用量页的历史区点击 **全量重扫用量统计**，扫描所有已索引会话，包括已归档会话。任务仅手动触发，可能耗时较久。`POST /api/usage/rescan` 无需请求体；运行中再次 POST 会返回同一个任务的当前进度。建议每秒轮询 `GET /api/usage/rescan`。两者沿用普通成功信封，`data` 包含 `state`（`idle`、`running`、`completed`、`failed`）、`scanned_sessions`、`total_sessions`、`scanned_records`、`started_at`、`finished_at` 和 `error`。时间为 epoch 毫秒或 `null`；未失败时 `error` 为 `null`。`scanned_records` 计入新读取的所有 wire 记录，包括非用量记录；检查点未变化时无需读取 wire。

任务绕过常规会话、记录和时间扫描预算，保存增量来源检查点；运行中常规查询继续读取已提交数据。常规查询的截止预算为 10 秒，清单枚举额度为 500 个会话、2048 个 Agent 来源，导入或恢复用量事实的预算为 200,000 条，包括未知和无效事实。下一次查询继续未完成的清单枚举与来源核对，不重复已完成的前缀；观察到单个会话变化时只核对该会话，每十分钟或监听不可用时通过完整清单修复遗漏。非用量 wire 记录不占用这项事实预算，查询已索引事实也不会再次消耗它。已删除会话与临时用量账本同样按常规查询预算接续。重扫完成不会补造供应商未返回的用量或缺失模型价格。任务进度仅在当前进程内保留，重启后回到 `idle`；已提交事实、来源覆盖和导入进度跨重启保留。暂不支持取消重扫任务。

历史统计与智能体累计用量共用轻量用量事实，随对话记录提交保存；已有有效用量检查点会自动迁移。没有可用检查点时，首次查询只恢复尚未覆盖的源记录；`reliability.complete=false` 表示当前小计尚未统计完整。后续查询从已提交进度继续；取消历史请求后，若没有其他调用方仍在等待，该次恢复会停止。有效用量事实仍在时，进程重启或重建其查询索引无需重新读取对话正文。

### 用量计价

`GET /api/usage/pricing` 返回配置中的模型 ID、已保存的覆盖，以及通过重复 `model` 查询参数指定的 ID。每个 `items` 项包含 `model`、配置的 `pricing_model`（未设时为 `null`）、`matched_key`、`source`（`override`、`litellm-cache`、`vendored` 或 `unknown`）和 `prices`（未知时为 `null`）。带路由前缀的模型按价格目录中的规范名匹配；价格是估算，不是代理的实际账单。服务器在 `<home>/model-pricing` 下刷新 LiteLLM 缓存，随包附带的 MIT 许可快照用于离线兜底。

`PUT /api/usage/pricing` 按键修改覆盖：未发出的键保持不变，`null` 删除该键的覆盖。所有单价均为**每 token**，不是每百万 token。提交每百万 token 报价前，先除以 1,000,000。输入、输出单价必填；缓存读、缓存写单价未知时可省略，但使用了未定价类别的请求仍是部分估算。

```json
{"overrides":{"proxy/model":{"input_cost_per_token":0.000002,"output_cost_per_token":0.00001,"cache_read_input_token_cost":0.0000002,"cache_creation_input_token_cost":0.0000025,"currency":"USD"}}}
```

以上仅为示例数字，不是 `proxy/model` 的公开报价。单价必须为有限非负数，`currency` 为三个大写字母。非 USD 覆盖会保存并返回，不做汇率换算，也不计入 `cost_usd_estimated`。未知模型不会获得虚构价格。覆盖沿用原子 TOML 存储，写入 `<home>/model-pricing/overrides.toml`，重启后保留。校验失败返回信封错误码 `40001`，存储失败为 `50001`。HTTP 客户端方法为 `klient.rest.usagePricing.get(models?)` 和 `.set({ overrides })`。

来源事实和覆盖水位保存在独立的 Usage SQLite 读模型中。Agent 清单、generation 及 wire 字节长度、修改时间不变时，复用已记录用量，不再读取 wire 边界；追加或指纹变化时增量恢复或切换替代 generation。没有 Agent 的会话计为完整零用量，不占用用量明细行。另一条记录缺少必要价格时，估算费用仍保留可完整计价记录的小计；不会只计算一条未能完整计价记录中已有单价的 token 类别。

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
| `GET /media-preview/{preview_id}` | 读取临时播放链接授权的本机或会话媒体 | 支持；无法满足的 Range 为 416 | 不支持（`private, no-store`） |

已建立索引的会话无需恢复会话即可读取规范媒体文件和暂存上传；规范文件的字节与文件名优先于暂存副本。获准访问的浏览器来源可以读取 `ETag`、`Content-Disposition` 和 `Content-Range`，分别用于缓存重验、文件名和分段响应；来源准入与鉴权规则不变。

错误语义也不相同：`GET /api/files/{file_id}` 和会话媒体下载对查找和存储失败返回真实 404 / 500 状态码（文件端点的参数校验失败仍走 HTTP 200 信封）。`/media-preview/{preview_id}` 的链接不存在、已撤销或已过期时，返回 HTTP 404 和 JSON 错误信封。工作区下载、本机原始文件预览和导出的失败仍走标准[响应信封](#响应信封)，客户端须检查其中的 `code`。

## 下一步

- [本地服务与 API](./local-server.md) — 启动、鉴权与端到端调用流程
- [kiki 命令](../reference/command.md#kiki-web) — `kiki web` 的全部命令行选项
