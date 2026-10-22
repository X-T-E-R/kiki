# 平台与模型

Kiki 可以同时连接多家模型提供商。API 密钥是适用范围最广的连接方式；桌面和浏览器设置还支持使用 Kimi Code、GitHub Copilot、ChatGPT（Codex）账号登录。Kimi 是受支持的服务之一，不是 Kiki 独有的提供商类别。提供商使用相应的通信协议，模型则各自声明 ID、上下文长度和能力。本页介绍 `config.toml` 中的协议类型以及配套的 [`credentials.toml`](./config-files.md#供应商凭证) API 密钥。

## 支持的供应商类型

`providers` 表里的 `type` 字段设置默认请求格式（API 请求体和端点），单个模型可通过 `protocol` 覆盖：

| 类型 | 协议 | 典型用途 |
| --- | --- | --- |
| `kimi` | OpenAI 兼容 | Kimi Code 托管服务、Kimi Platform API 密钥 |
| `anthropic` | Anthropic Messages | Claude 系列模型 |
| `openai` | OpenAI Chat Completions | OpenAI 及兼容服务、DeepSeek、Qwen 等 |
| `openai_responses` | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

所有供应商默认以流式方式与模型交互。thinking、视觉、工具调用等能力按模型名前缀自动匹配，通常不需要手动声明。

**凭证优先级**：`api_key` 直接字段 > `[providers.<name>.env]` 子表键 > 两者都缺时启动报错。两者都从配置文件读取——`credentials.toml` 覆盖 `config.toml`——CLI 不会从 shell 环境变量自动取凭证。详见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

### 模型请求格式覆盖

同一网关下的某个模型需要不同 API 时，在模型上设置 `protocol`。可选值为 `openai`（Chat Completions）、`openai_responses`（Responses）、`anthropic`（Messages）和 `google-genai`（Google GenAI）。不填则继承供应商默认格式；删除此字段即可恢复继承。`kimi` 和 `vertexai` 是供应商类型，不是模型协议值。

```toml
[providers.gateway]
type = "openai"
base_url = "https://example.com/v1"

[models.chat]
provider = "gateway"
model = "remote-chat"
max_context_size = 128000

[models.responses]
provider = "gateway"
model = "remote-responses"
max_context_size = 128000
protocol = "openai_responses"
```

将示例地址和远端模型 ID 替换为实际服务的值。两个模型共用网关凭据。覆盖只改变 API 请求体和路径，不改变供应商、默认模型、请求身份或主／子智能体使用参数。端点必须支持所选 API；若请求被拒绝，改用服务支持的格式或删除覆盖。Kiki 不会静默尝试另一种协议。

[模型 REST API](../server/rest-api.md#模型与供应商) 分别返回已保存的 `protocol` 和求解后的请求格式 `effective_protocol`。保存格式不会测试连接是否可用。

## 请求压缩

请求压缩在你配置之前保持关闭。`[request_compression]` 作用于每个没有单独设置的供应商。供应商表按字段覆盖，并继承未写的字段：省略的 `targets`、`min_bytes` 或 `dictionary` 保持系统表里的值。供应商一旦写下 `targets`，就按原顺序整体替换系统列表，不会把两份列表接在一起。不写供应商键则继承。供应商设置 `encoding = "off"` 时，即使系统表已开启，该供应商也不压缩。没有系统表时，只有本来就写了 `request_compression` 的供应商会压缩。

```toml
[request_compression]
encoding = "zstd"
targets = ["https://example.com/v1"]
min_bytes = 1024
dictionary = true

[providers.gateway.request_compression]
min_bytes = 0
```

上面的供应商仍使用 zstd、同一组目标地址和字典同意，只改了体积阈值。省略 `dictionary` 会保留系统选择。`dictionary = false` 表示该供应商拒绝留存。`dictionary` 只适用于 zstd。保存任一张表后，下一次模型请求即生效。`POST /api/config` 写入系统表。`GET /api/providers` 按已保存的内容返回供应商表，包括不完整字段、`encoding` 为 `"off"`，以及原来的 `targets` 顺序。

网关明确支持压缩请求体时，此配置适用于 Responses、Messages 和 Chat Completions；其他协议保持原有传输路径。写下一个目标地址并不会跳过网关自己的压缩支持。

```toml
[providers.gateway.request_compression]
encoding = "gzip"
targets = ["https://example.com/v1"]
min_bytes = 1024
```

`targets` 列出已支持压缩的 HTTP(S) API 基础地址，请求必须匹配来源和路径边界；把模型切到其他端点不会自动为新地址启用压缩。`min_bytes` 按 UTF-8 请求体字节计数，默认 1024。空请求体、小包、流式请求体、已有编码或非 JSON 请求体保持不变；只有压缩后更小才采用压缩结果。删除供应商表即恢复继承；设置 `encoding = "off"` 则只关闭该供应商。删除系统表后，所有未单独设置的供应商不再压缩。

使用普通 zstd 时，改为 `encoding = "zstd"`。gzip 和普通 zstd 都不会要求网关留存请求体。若网关还实现了 Portway 请求字典扩展，可单独明确同意临时留存请求体：

```toml
[providers.gateway.request_compression]
encoding = "zstd"
targets = ["https://example.com/v1"]
dictionary = true
```

`dictionary = true` 要求网关缓存精确请求字节，其中可能包含消息、媒体、工具结果和签名。Kiki 只在有容量上限的进程内存中保存已确认的字典，最长十分钟。字典确认只表示字节已缓存，不表示模型生成完成。每次请求仍由完整本地历史构建，不会从猜测的模型输出重建编辑或压缩后的历史。

只有带明确标记的推理前解码拒绝才允许切换编码重试，最多三次。响应丢失或送达不确定时，不会自动重新生成。目标不支持压缩时，先关闭压缩再发起新请求，不依赖自动尝试未知格式。

## 通过 WebSocket 增量传输 Responses

Responses WebSocket 在你配置之前保持关闭。`[responses_web_socket]` 作用于每个没有单独设置的供应商。供应商表整体替换系统值。供应商写下 `targets` 时，按原顺序替换系统列表，不会追加。不写供应商键则继承。`off = true` 让该供应商保持普通 HTTP，即使系统表列出了目标。没有系统表时，只有写了 `responses_web_socket` 的供应商会打开连接。保存任一张表后，下一次模型请求即生效，并关闭已打开的连接。

网关在握手中通过 `X-Responses-WebSocket-Capabilities` 声明支持版本 1 时，可明确启用连接内的 Responses 历史复用：

```toml
[responses_web_socket]
targets = ["https://example.com/v1"]

[providers.gateway]
type = "openai_responses"
base_url = "https://example.com/v1"

[providers.other.responses_web_socket]
off = true
```

目标必须匹配 Responses 端点的来源和路径边界。写下一个目标地址并不会跳过握手。Kiki 使用官方 OpenAI SDK，每个 Agent 各持一个连接；上次已完成响应仍匹配本地历史时，只发送新增输入。辅助请求、其他 Agent 和 fork 不共享这条历史。取消请求会关闭连接；模型、凭据、策略或上下文变化时，会重建连接或发送完整请求。删除供应商表即恢复继承；设置 `off = true` 则该供应商保持普通 HTTP。删除系统表后，所有未单独设置的供应商保持普通 HTTP。

网关会在连接上临时保存原生请求和响应项。与 HTTP 请求字典不同，这些状态随生成完成提交，不由字典确认推进。未知输出字段保留在内存中的附属状态里，后续发送完整请求，不用于增量请求。

网关明确报告推理前历史缺失时，Kiki 会发送一次当前完整历史。推理前拒绝上游格式或提示词策略时，可转为完整 HTTP 请求。访问拒绝、送达不确定或已收到部分响应时，不会自动重放。此路径只支持 `response.create` 生成，不启用后台生成、steering 或 `generate:false` 预热。

## `/provider` — 交互式供应商管理

不想手动编辑 TOML？在 TUI 里输入 `/provider` 打开**供应商管理器**，可以以交互方式添加或删除供应商。

管理器按来源把供应商显示为一行行条目。操作方式：

- ↑/↓ 移动光标，←/→ 翻页
- `d` 键删除当前供应商（有 `[y/N]` 确认）
- 在 `[ Add New Platform ]` 行按 Enter 添加新供应商

添加时有两条路径：

- **Known third-party provider**：从 [models.dev](https://models.dev/) 目录里选供应商 → 输入 API 密钥 → 选默认模型。目录没写明协议的供应商（xai、openrouter 这类厂商专用 SDK）会按 OpenAI 兼容协议导入，并标为 guessed；目录里没有可用端点时，会先让你填 base URL。Amazon Bedrock / Cohere 这类专有协议无法导入。已下线（deprecated）和 alpha 状态的模型不会出现在导入列表中。公共目录不可达时，Kiki 会回退到内置目录快照，离线也能完成导入。
- **Custom registry (api.json)**：粘贴自定义 registry 地址和 Bearer token，本次显式导入会创建 `providers` / `models` 条目。后续启动不会同步上游新增、删除供应商或模型元数据变化。

### 获取模型建议

在 GUI **设置 → 模型与提供商** 中点击**获取模型**，可从已配置的提供商获取建议。API 密钥提供商和自定义 registry 只在请求时获取，不随启动或定时任务刷新。获取不会修改提供商、已配置模型或默认模型；选中建议并单独保存后才会添加模型，上游删除也不会删除已有模型。

建议只保存在服务器内存中，服务器重启后消失。修改或删除提供商连接会丢弃该连接的缓存建议。获取失败会显示错误并保留上次成功的建议；成功返回空列表则清空建议。该提供商已配置的模型不会重复出现，即使本地别名与上游模型 ID 不同。

在 GUI 的 **设置 → 模型与提供商 → 服务与账号** 中，**用 API 密钥连接**提供五个协议入口：`openai`、`openai_responses`、`anthropic`、`google-genai`、`vertexai`；也可以按服务名称搜索。搜索 DeepSeek、GLM、Kimi、Ollama、LM Studio 或 OpenRouter，选中结果后会自动填入协议和 base URL。没有匹配结果时，选协议后手填 base URL；之后按需填写密钥并添加模型。

Ollama 和 LM Studio 与其他 OpenAI 兼容服务共用 API 密钥路径，本地服务可能无需密钥。五个快捷入口是 OpenAI、Anthropic、Google Gemini、DeepSeek 和 Moonshot（Kimi）——Kimi 快捷入口配置的就是下文的 `kimi` 供应商。

**可用模型**集中展示已配置的模型：按名称或 ID 搜索、查看上下文长度与能力，星标一个模型作为全局默认。提供商还保留自身的默认模型，模型也保留实际发送给上游的 ID。手动填写的 Kimi API 密钥和其他 API 密钥连接一样只获取建议；账号登录则配置其托管模型。

::: warning
通过 `/login` 登录的 Kimi Code OAuth 托管账号不会在 `/provider` 里显示，请用 `/login` 和 `/logout` 管理。
:::

非交互环境下也可以用 shell 命令完成同样操作：[`kiki provider`](../reference/command.md#kiki-provider)。

## `kimi`

用于对接 Moonshot AI 的 OpenAI 兼容接口，包括 Kimi Code 托管服务和 Kimi Platform API 密钥。

- 默认 `base_url`：`https://api.moonshot.ai/v1`
- 凭证键名：`KIMI_API_KEY`、`KIMI_BASE_URL` ——这些键名写在 `[providers.<name>.env]` 子表里，不是 shell 环境变量
- 额外能力：支持视频上传

Kimi Code 订阅密钥配合托管 base URL `https://api.kimi.com/coding/v1` 使用（`/login` 登录后自动配置）。开放平台密钥按签发门户选择端点：[platform.kimi.com](https://platform.kimi.com) 签发的密钥配 `https://api.moonshot.cn/v1`，[platform.kimi.ai](https://platform.kimi.ai) 签发的密钥配默认的 `https://api.moonshot.ai/v1`。

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.kimi]
api_key = "sk-xxxxx"
```

> 使用 Kimi Code 托管服务时，`/login` 登录后会自动配置 `base_url` 和凭证，无需手动填写。

对于标准的 Kimi Code 托管凭证槽，如果 Kiki 自己的凭证槽没有 token，也可以复用已有的 Kimi Code 登录。默认读取 `~/.kimi-code`，也可以用 `KIMI_CODE_HOME` 指定原版目录，并遵循该目录的 `credentials_store` 设置。这里选择的是凭证槽，不会虚构已核实的账号身份。显式连接的原版来源会保持选中；从 Kiki 断开时不会删除原版凭证。

当 `credentials_store = "keyring"` 时，keyring 不可用会报告存储错误，而不是把账号标成已登出；恢复 keyring 后再重试。`auto` 模式可以使用可读的文件副本。复用原版来源时，Kiki 会原地读取凭证，不会复制到自己的凭证目录。

## `anthropic`

用于对接 Claude API。标准 Claude 模型自动启用视觉、工具调用及 Thinking（如支持）；自定义或未覆盖的模型需在 `[models.<alias>]` 里显式声明 `capabilities`。

- 默认 `base_url`：跟随 Anthropic SDK 默认值
- 凭证键名：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 默认 `max_tokens`：按模型自动推断。如需覆盖，在模型别名上设 `max_output_size`

```toml
[providers.anthropic]
type = "anthropic"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # 可选，省略时使用模型推断的默认值
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.anthropic]
api_key = "sk-ant-xxxxx"
```

## `openai`

用于对接 OpenAI Chat Completions 协议，也可连接任何兼容该协议的第三方服务（覆盖 `base_url` 即可）。

第三方推理模型（DeepSeek、Qwen、One API 等）开箱即用：CLI 自动处理 `reasoning_content` 字段和 `reasoning_effort` 注入。如果你的网关用非标准字段名返回推理内容，在模型别名上设 `reasoning_key` 覆盖。

对 `openai` 和 `openai_responses`，当你没有设过输出上限、模型能力也未知时，Kiki 不再自己发输出长度限制——请求里不会带 `max_tokens`、`max_completion_tokens` 或 `max_output_tokens`，由服务端自己的默认决定。你自己设的上限、已知的模型输出能力、session 或 profile 上更紧的限制，以及剩余窗口预算都照常生效；上下文窗口大小本身不被当作输出上限。这个最大值是天花板，不是对回答长度的保证——模型实际返回多少还取决于任务本身和它何时停止——费用按你实际得到的响应计算。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.openai]
api_key = "sk-xxxxx"
```

## `openai_responses`

对应 OpenAI 较新的 Responses API，始终以流式方式工作。配置方式与 `openai` 相同。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai_responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.openai_responses]
api_key = "sk-xxxxx"
```

## `google-genai`

用于直连 Google Gemini API。thinking、视觉及多模态能力按模型名自动识别。

- 凭证键名：`GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.gemini]
api_key = "xxxxx"
```

如需经由兼容 Gemini 协议的代理/网关访问，可设置 `base_url`（或 `GOOGLE_GEMINI_BASE_URL` 环境变量）；不填时使用 SDK 默认地址 `https://generativelanguage.googleapis.com`。

> 只填**主机根地址**。Google GenAI SDK 会自行追加 API 版本与路径（如 `/v1beta/models/<model>:generateContent`），所以结尾带 `/v1beta` 会导致路径重复成 `/v1beta/v1beta/…`。

```toml
[providers.gemini]
type = "google-genai"
base_url = "https://your-gateway.example"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.gemini]
api_key = "xxxxx"
```

## `vertexai`

与 [`google-genai`](#google-genai) 共用 Google GenAI 客户端，但请求留在 Vertex AI，不会改走 Gemini Developer API（`generativelanguage.googleapis.com`）。`vertexai` 是供应商类型，不是模型的 `protocol` 值。

### API 密钥

把密钥写成 `credentials.toml` 里的 `api_key`，或写在供应商 `[providers.<name>.env]` 子表的 `VERTEXAI_API_KEY`。

项目和区域都留空时，请求发往 `https://aiplatform.googleapis.com`，API 版本为 `v1`，请求头是 `x-goog-api-key`。路径形如 `/v1/publishers/google/models/<model>:streamGenerateContent`。

```toml
[providers.vertex]
type = "vertexai"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.vertex]
api_key = "xxxxx"
```

同时写了 `GOOGLE_CLOUD_PROJECT` 和 `GOOGLE_CLOUD_LOCATION` 时，同一把密钥发到项目资源上。主机与同一 location 的项目 ADC 相同。`global` 使用 `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/<model>:streamGenerateContent`。`us` 使用 `https://aiplatform.us.rep.googleapis.com`，`eu` 使用 `https://aiplatform.eu.rep.googleapis.com`，路径都是 `/v1/projects/<project>/locations/<location>/publishers/google/models/<model>:streamGenerateContent`。其他 location 使用 `https://<location>-aiplatform.googleapis.com` 和同一条项目路径。

项目和区域要同时填写，或同时留空。只填其中一个会被拒绝。模型 ID 已经以 `projects/` 开头时按原样发送。模型 ID 以 `publishers/` 开头时，不能同时填写项目和区域。

### 项目 ADC

把项目 ID 和 location 写在供应商 env 子表里，并留空 API 密钥。在 shell 里 `export GOOGLE_CLOUD_PROJECT` 不会被读取。认证使用 Google Cloud 应用默认凭据：`gcloud auth application-default login`，或把 `GOOGLE_APPLICATION_CREDENTIALS` 指到服务账号 JSON 文件。

请求使用 API 版本 `v1beta1`，路径以 `/v1beta1/projects/<project>/locations/<location>/` 开头。`global` 使用 `https://aiplatform.googleapis.com`。`us` 使用 `https://aiplatform.us.rep.googleapis.com`。`eu` 使用 `https://aiplatform.eu.rep.googleapis.com`。其他 location 使用 `https://<location>-aiplatform.googleapis.com`。

```toml
[providers.vertex]
type = "vertexai"

[providers.vertex.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login
kiki
```

这些路线都可以用 `base_url`（或供应商 env 子表里的 `GOOGLE_VERTEX_BASE_URL`）改走自定义主机。只填主机根地址，客户端会自行追加 API 版本和路径。

`google-genai` 保持 Gemini Developer API，除非该供应商的 env 子表同时写了 `GOOGLE_CLOUD_PROJECT` 和 `GOOGLE_CLOUD_LOCATION`。这两个坐标会改走 Vertex AI，该供应商配置的 API 密钥仍会发送。`vertexai` 的 API 密钥在写了这两个坐标时仍留在 Vertex AI。

## OAuth 与凭证注入

GUI 的 **服务与账号 → 用账号登录** 提供 Kimi Code、GitHub Copilot、ChatGPT（Codex）三种选项。选择账号后打开验证地址、输入设备码，等待页面显示「已连接」。对应账号须有相关订阅或服务权限；可用模型取决于账号。退出登录会移除该账号的托管连接与模型。这些是登录方式，并非新的 `type` 协议值：Kimi Code 与 Copilot 使用 OpenAI 兼容请求，ChatGPT Codex 使用指向 Codex 端点的 `openai_responses`。OAuth 凭据存放在 `credentials/` 的 JSON 文件中（见[数据路径](./data-locations.md)）；API 密钥存放在 `credentials/credentials.toml`。CLI 的 `/login`、`/logout` 目前仍只管理 Kimi Code。

## 请求身份

上面的小节决定 Kiki 连到哪个端点、用哪把密钥；**请求身份**（request identity）决定每个请求以哪个客户端的身份发出——它写入发往 provider 端点的 `User-Agent` 和额外请求头，服务端据此把这段流量认成 Codex CLI、Claude Code、Grok Build、OpenCode 或 Kiki 自己的客户端。它与 [`[identity]`](./config-files.md#identity)（运行时显示名称和 slug）是两件不同的事。

身份只提供这批客户端标识字段。`base_url`、API 密钥和认证方式仍然由你在供应商配置和 `credentials.toml` 里决定；`Authorization`、`x-api-key`、`Cookie`、`Content-Type` 这类鉴权与传输头不接受身份声明。

### 内置身份

Kiki 内置六种身份。内置身份只读，用「复制并编辑」得到的自定义身份可以明文修改 User-Agent、请求头和请求体字段，值里支持 `{version}`、`{model}`、`{os_type}` 等占位符：

| 身份 | preset / 身份 ID | 请求特征 |
| --- | --- | --- |
| Kimi Code | `kimi_code` / `kimi_code` | Kiki 原生客户端：在 Kimi 提供商上附带 `X-Msh-*` 设备头 |
| Codex CLI | `codex_compatible` / `codex` | `codex_cli_rs/{version}` User-Agent 与 `originator`，仅 OpenAI Responses |
| Claude Code | `claude_code_compatible` / `claude_code` | `claude-cli/{version} (external, cli)` User-Agent、`x-app` 及 `X-Stainless-*`，仅 Anthropic Messages |
| Grok Build | `grok_build_compatible` / `grok_build` | `grok-shell/{version}` User-Agent 与 `x-grok-*` 会话、轮次请求头，可用于 Chat Completions、Responses 或 Messages |
| OpenCode | `opencode_compatible` / `opencode` | `opencode/{version}` User-Agent、`x-opencode-client: cli`，以及动态的 `x-opencode-session`、`x-opencode-request` |
| 无 | `none` / `none` | 不发送 Kiki 自选的身份字段：User-Agent、保留身份请求头与 `X-Msh-*` 设备头都会被移除。供应商认证协议要求的字段仍会发出——OAuth token、账号请求头、Grok 客户端版本标记——因为那些属于协议本身，不属于身份 |

### OpenCode

选 `OpenCode` 身份后，上游看到的是一个 OpenCode 命令行客户端：

- `User-Agent: opencode/{version}`，版本默认取 Kiki 内置的 OpenCode CLI 版本（npm 包 `opencode-ai`，当前内置 1.18.21）
- `x-opencode-client: cli`，值固定
- `x-opencode-session`：每个 Agent 会话一个，会话内保持不变，让上游把该会话的请求归到同一个 OpenCode 会话
- `x-opencode-request`：每个轮次重新生成，标识单次请求

该身份在 OpenAI Responses、Anthropic Messages 和 OpenAI Chat Completions 上都能用，不像 Codex 身份仅限 Responses、Claude Code 身份仅限 Messages。

### 在哪里配置

GUI 的 **设置 → 模型与提供商 → 身份** 是集中页面：左列列出内置（只读）与自定义身份，右侧预览该身份实际发送的请求头与请求体字段，另有客户端版本、各层使用情况和最近请求三张卡片。身份分三层生效，全局层由该标签的「默认请求身份」卡片设置，供应商层和模型层在 **设置 → 模型与提供商** 里设置：

| 层 | GUI 位置 | `config.toml` |
| --- | --- | --- |
| 全局默认 | 设置 → 模型与提供商 → 身份 | `[request_identity]` |
| 供应商 | 设置 → 模型与提供商 → 供应商编辑器 → 「请求身份」 | `[providers.<name>.request_identity]` |
| 模型 | 设置 → 模型与提供商 → 模型编辑器 → 「请求身份」 | `[models."<alias>".request_identity]` |

后面的层覆盖前面的层（全局 → 供应商 → 模型）。一层都不设置时，普通 API key 连接使用内置的 Kimi Code 身份，走 Codex 或 Grok Build OAuth 登录的供应商使用该供应商的默认身份。选某个兼容 preset 会先清空更低层的身份，再应用该层可选的 `overrides` 稀疏调整（如 `lineage.format`、`client.user_agent`、`request.logical_id`）。让一家供应商的流量以 OpenCode 身份发出只需：

```toml
[providers.my-gateway.request_identity]
preset = "opencode_compatible"
```

### 客户端版本

内置身份携带的客户端版本跟随 Kiki 内置值，也可以在「请求身份」页的「客户端版本」卡片里从 npm 仓库、本机 CLI（如 `opencode --version`）或清单 URL 检查上游最新版。检查只暂存候选版本，请求仍使用当前版本，直到你手动应用；也可以钉住版本，或回滚到历史版本。

## 下一步

- [配置文件](./config-files.md) — `providers` 和 `models` 表的完整字段参考
- [配置覆盖](./overrides.md) — 供应商凭证的解析优先级规则
- [环境变量](./env-vars.md) — 各供应商对应的凭证键名列表
