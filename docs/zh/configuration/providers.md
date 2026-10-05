# 平台与模型

Kiki 可以同时连接多家模型提供商。API 密钥是适用范围最广的连接方式；桌面和浏览器设置还支持使用 Kimi Code、GitHub Copilot、ChatGPT（Codex）账号登录。Kimi 是受支持的服务之一，不是 Kiki 独有的提供商类别。提供商使用相应的通信协议，模型则各自声明 ID、上下文长度和能力。本页介绍 `config.toml` 中的协议类型以及配套的 [`credentials.toml`](./config-files.md#供应商凭证) API 密钥。

## 支持的供应商类型

`providers` 表里的 `type` 字段决定使用哪种协议实现：

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

在 GUI 的 **设置 → 模型与提供商 → 连接服务** 中，**用 API 密钥连接**提供五个协议入口：`openai`、`openai_responses`、`anthropic`、`google-genai`、`vertexai`；也可以按服务名称搜索。搜索 DeepSeek、GLM、Kimi、Ollama、LM Studio 或 OpenRouter，选中结果后会自动填入协议和 base URL。没有匹配结果时，选协议后手填 base URL；之后按需填写密钥并添加模型。

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

与 `google-genai` 共用实现，`type = "vertexai"` 时切换到 Vertex AI 访问路径。

- 凭证键名：`VERTEXAI_API_KEY` ——写在 `[providers.vertexai.env]` 子表里，并与其他供应商 API 密钥一样存放在 `credentials.toml`；是不走下文 ADC 流程时的 API 密钥来源

认证走 Google Cloud 标准 ADC 流程（`gcloud auth application-default login`，或 `GOOGLE_APPLICATION_CREDENTIALS` 指向的服务账号 JSON 文件）。**项目 ID 和区域必须写在 `[providers.vertexai.env]` 子表里**——在 shell 里 `export GOOGLE_CLOUD_PROJECT` 不起作用。

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # 一次性完成认证
kiki
```

如需让 Vertex 请求走自定义（如代理）端点，可设置 `base_url`（或 `GOOGLE_VERTEX_BASE_URL` 环境变量）；不填时使用 SDK 默认的区域化 `*-aiplatform.googleapis.com` 地址。与 `google-genai` 一样，只填主机根地址——SDK 会自行追加 `/v1beta1/publishers/google/models/…`。

## OAuth 与凭证注入

GUI 的 **连接服务 → 用账号登录** 提供 Kimi Code、GitHub Copilot、ChatGPT（Codex）三种选项。选择账号后打开验证地址、输入设备码，等待页面显示「已连接」。对应账号须有相关订阅或服务权限；可用模型取决于账号。退出登录会移除该账号的托管连接与模型。这些是登录方式，并非新的 `type` 协议值：Kimi Code 与 Copilot 使用 OpenAI 兼容请求，ChatGPT Codex 使用指向 Codex 端点的 `openai_responses`。OAuth 凭据存放在 `credentials/` 的 JSON 文件中（见[数据路径](./data-locations.md)）；API 密钥存放在 `credentials/credentials.toml`。CLI 的 `/login`、`/logout` 目前仍只管理 Kimi Code。

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

GUI 的 **设置 → 请求身份** 是集中页面：左列列出内置（只读）与自定义身份，右侧预览该身份实际发送的请求头与请求体字段，另有客户端版本、各层使用情况和最近请求三张卡片。身份分三层生效，全局层由该页的「默认请求身份」卡片设置，供应商层和模型层在 **设置 → 模型与提供商** 里设置：

| 层 | GUI 位置 | `config.toml` |
| --- | --- | --- |
| 全局默认 | 设置 → 请求身份 | `[request_identity]` |
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
