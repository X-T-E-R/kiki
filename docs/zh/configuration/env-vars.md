# 环境变量

Kiki 通过环境变量控制少数运行时行为——迁移数据目录，以及不改配置文件临时切换模型。

Kiki 自有运行时开关统一使用 `KIKI_*` 前缀。`KIMI_API_KEY` 和 `KIMI_BASE_URL` 等供应商凭证键属于上游生态，单独在下文说明。以本页列出的确切变量名为准。

::: warning 重要：API 密钥不在这里配置
`KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等密钥变量**不会**从 shell 环境变量自动读取。在终端里 `export KIMI_API_KEY=xxx` 不会让任何供应商获得密钥——必须写在 `config.toml` 的 `[providers.<name>]` 段或 `[providers.<name>.env]` 子表里。

唯一的例外是 `KIKI_MODEL_*` 系列，它是一个显式通道，*确实*会从 shell 读取凭证——详见[用环境变量定义模型](#用环境变量定义模型-kiki-model)。

背景说明见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。
:::

## 核心路径

### `KIKI_HOME`

覆盖数据根目录，默认 `~/.kiki`。设置后，配置文件、会话、日志、OAuth 凭据等全部数据都落到新路径下：

```sh
export KIKI_HOME="/path/to/custom/kiki"
```

> 确保目录可写。多个 `kiki` 实例共用同一个 `KIKI_HOME` 会共享配置和凭证。

数据目录的完整结构见[数据路径](./data-locations.md)。

### `KIKI_MODEL_*` 系列

不修改 `config.toml` 临时切换模型——设置 `KIKI_MODEL_NAME` 后，CLI 在内存里合成一个临时供应商，重启后失效。详见[用环境变量定义模型](#用环境变量定义模型-kiki-model)。

## 供应商凭证键（写在 config.toml 里）

下面这些键名不是直接从 shell 读取的——它们是写在 `config.toml` 的 `[providers.<name>.env]` 子表里、作为 `api_key` / `base_url` 备用来源的键名。CLI 只从配置文件读取，不从 `process.env` 读取。

这样设计是为了让你保留熟悉的键名写法，同时把密钥放在配置文件里统一管理：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

各供应商对应的键名：

| 键名 | 适用供应商 | 默认值 |
| --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | 无 |
| `KIMI_BASE_URL` | Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | 无 |
| `ANTHROPIC_BASE_URL` | Anthropic | Anthropic SDK 默认值 |
| `OPENAI_API_KEY` | OpenAI（`openai` 和 `openai_responses`） | 无 |
| `OPENAI_BASE_URL` | OpenAI（`openai` 和 `openai_responses`） | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI、Vertex AI | 无 |
| `GOOGLE_GEMINI_BASE_URL` | Google GenAI（`google-genai`） | `https://generativelanguage.googleapis.com` |
| `GOOGLE_VERTEX_BASE_URL` | Vertex AI（`vertexai`） | SDK 默认的区域化 `*-aiplatform.googleapis.com` 地址 |
| `VERTEXAI_API_KEY` | Vertex AI | 无 |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | 无 |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | 无 |

::: warning
`GOOGLE_APPLICATION_CREDENTIALS`（服务账号 JSON 路径）是唯一走系统环境变量的例外——它由 Google SDK 自身通过 ADC 流程读取，CLI 不参与。其他所有键名都必须写在 `[providers.<name>.env]` 子表里。
:::

供应商类型与字段的完整说明见[平台与模型](./providers.md)。

## OAuth 与托管端点

这组变量用于将 OAuth 认证和托管服务端点指向自建或测试环境，日常使用不需要设置。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIKI_CODE_OAUTH_HOST` | OAuth 认证 host，优先级最高 | 未设时回退到 `KIKI_OAUTH_HOST` |
| `KIKI_OAUTH_HOST` | OAuth 认证 host，作为上一个的 fallback | 未设时使用 `https://auth.kimi.com` |
| `KIKI_CODE_BASE_URL` | OAuth 登录后的托管 API base URL | `https://api.kimi.com/coding/v1` |

::: warning
`KIKI_CODE_BASE_URL`（OAuth 托管服务，指向 `kimi.com`）和 `KIMI_BASE_URL`（API 密钥直连，指向 `moonshot.ai`）是两个不同的变量，请按场景区分。
:::

## 用环境变量定义模型（`KIKI_MODEL_*`）

测试时想换个模型但不想动 `config.toml`？设置 `KIKI_MODEL_NAME` 后，CLI 会从 `KIKI_MODEL_*` 系列变量在内存里合成出一个临时供应商和模型别名，不写回配置文件。优先级高于 `config.toml` 的 `default_model`，但低于启动时 `-m <alias>` 选项。

```sh
export KIKI_MODEL_NAME="kimi-for-coding"
export KIKI_MODEL_API_KEY="YOUR_API_KEY"
export KIKI_MODEL_BASE_URL="https://api.example.com/v1"
export KIKI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIKI_MODEL_CAPABILITIES="image_in,thinking"
kiki
```

完整变量列表：

| 环境变量 | 必填 | 用途 | 默认值 |
| --- | --- | --- | --- |
| `KIKI_MODEL_NAME` | 是（同时是启用开关） | 发送给 API 的模型 ID | — |
| `KIKI_MODEL_API_KEY` | 是 | API 密钥 | — |
| `KIKI_MODEL_PROVIDER_TYPE` | 否 | 供应商类型：`kimi`、`anthropic`、`openai` | `kimi` |
| `KIKI_MODEL_BASE_URL` | 否 | API 基础 URL | 各类型有各自默认值 |
| `KIKI_MODEL_MAX_CONTEXT_SIZE` | 否 | 最大上下文长度（token 数） | `262144`（256K） |
| `KIKI_MODEL_CAPABILITIES` | 否 | 逗号分隔的能力标签，与自动探测的能力取并集 | `image_in,thinking` |
| `KIKI_MODEL_DISPLAY_NAME` | 否 | 在 `/model` 中显示的名称 | 回退到 `KIKI_MODEL_NAME` |
| `KIKI_MODEL_MAX_OUTPUT_SIZE` | 否 | 单次输出上限（仅 `anthropic`）；设置后会覆盖内置的 Claude 上限 | 模型默认值 |
| `KIKI_MODEL_REASONING_KEY` | 否 | 推理字段名覆盖（仅 `openai`） | 自动探测 |
| `KIKI_MODEL_THINKING_EFFORT` | 否 | 临时模型的 Thinking 强度：`low`/`medium`/`high`/`xhigh`/`max`；仅在设置了 `KIKI_MODEL_NAME` 时读取（与下文同名运行时开关是两回事） | — |
| `KIKI_MODEL_ADAPTIVE_THINKING` | 否 | 强制开启或关闭 adaptive thinking（仅 `anthropic`） | 按模型名推断 |

设置了 `KIKI_MODEL_NAME` 但缺少必填变量时，启动会立即失败并给出明确提示。

注意：`KIKI_MODEL_THINKING_EFFORT` 有两个独立的读取点——这里在设置了 `KIKI_MODEL_NAME` 时用来设定临时模型的 effort；下文的同名运行时开关则与 `KIKI_MODEL_NAME` 无关，为所有 `kimi` 供应商请求在线上强制指定 effort。

## 运行时开关

控制后台任务、内置搜索与抓取模块、plugin marketplace 等子系统行为的开关变量：

| 环境变量 | 用途 | 合法值 |
| --- | --- | --- |
| `KIKI_PASSWORD` | 为 `kiki web` 本地服务设置并列鉴权密码，与 bearer token 同时有效；把服务绑定到非本机地址时建议设置，见[本地服务与 API](../server/local-server.md#鉴权) | 任意非空字符串；未设置时仅 token 有效 |
| `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` | 会话关闭时是否保留后台任务，优先级高于 `config.toml`。默认会在退出时停止后台任务 | 真值：`1`/`true`/`yes`/`on`；假值：`0`/`false`/`no`/`off` |
| `KIKI_BACKGROUND_MAX_RUNNING_TASKS` | 同时运行的后台任务数上限，优先级高于 `config.toml` 的 `[background] max_running_tasks`（不设置表示无上限） | 正整数；非法值被忽略 |
| `KIKI_IMAGE_MAX_EDGE_PX` | 图片压缩的最长边上限（像素），优先级高于 `config.toml` 的 `[image] max_edge_px`（默认 `2000`） | 正整数；非法值被忽略 |
| `KIKI_IMAGE_READ_BYTE_BUDGET` | 模型自行读图（`ReadMediaFile` 默认读取）的单图字节预算，优先级高于 `config.toml` 的 `[image] read_byte_budget`（默认 `262144`，即 256 KB） | 正整数；非法值被忽略 |
| `KIKI_PLUGIN_MARKETPLACE_URL` | 设置 `/plugins` 加载的 plugin marketplace JSON，优先级高于 `[plugins] marketplace_url` | `http://` 或 `https://` URL、`file://` URL 或本地路径；未设置或留空时不加载远程目录 |
| `KIKI_SUBAGENT_TIMEOUT_MS` | 单个 subagent（`AgentRun`）可运行的最长时间（毫秒）；优先级高于 `config.toml` 的 `[subagent] timeout_ms`（默认 `7200000`，即 2 小时） | 正整数；非法值回退到配置或默认值 |
| `KIKI_IDENTITY_NAME` | Agent 在系统提示词中的自称，优先级高于 `config.toml` 的 `[identity] name`，且不会被写回配置文件 | 任意非空字符串；空值视为未设置 |
| `KIKI_IDENTITY_SLUG` | 协议标识，用于发给第三方 provider 的 `User-Agent` 产品名和 MCP 客户端名，优先级高于 `[identity] slug`。未设置时由名称派生 | 任意非空字符串；会转小写并将连续非字母数字字符折叠为 `-` |
| `KIKI_BUILTIN_PRODUCT_SKILLS` | 是否向模型提供介绍 Kiki 自身的内置 Skills，优先级高于 `config.toml` 的 `builtin_product_skills`（默认开启） | 真值：`1`/`true`/`yes`/`on`；假值：`0`/`false`/`no`/`off` |
| `KIKI_TUI_FULL_SCREEN` | 启用实验性的 fullscreen alternate-screen 界面：可滚动的 transcript 视口、鼠标选择文本、可点击链接、Ctrl-Shift-F 搜索 | `1` 开启；其他值保持常规内联界面 |
| `KIKI_EXPERIMENTAL_TASK_WAIT` | 是否向模型提供 `TaskWait` 工具——它可以在当前轮次内等待后台任务，而不必结束这一轮（默认启用） | 真值：`1`/`true`/`yes`/`on`；假值：`0`/`false`/`no`/`off` |
| `KIKI_MCP_CONFIG_PATH` | 供外部编排器注入的 MCP 配置文件路径，由 `kiki web` 启动的服务端只读加载。必须与 `KIKI_MCP_AGENT_PROFILE_HOME`、`KIKI_MCP_CONFIG_READ_ONLY` 同时设置，否则启动直接报错 | 绝对路径 |
| `KIKI_MCP_AGENT_PROFILE_HOME` | 供外部编排器注入的 agent profile 根目录，与 `KIKI_MCP_CONFIG_PATH` 一起使用；三个 `KIKI_MCP_*` 目录变量必须同时设置 | 绝对路径 |
| `KIKI_MCP_CONFIG_READ_ONLY` | 注入目录的只读标记；必须为 `1`，服务端不会写回注入的配置或 profile | `1` |
| `KIKI_MCP_STARTUP_TIMEOUT_MS` | 所有 MCP server 的全局默认连接超时（毫秒）；优先级高于 `config.toml` 的 `[mcp] startup_timeout_ms`，但低于 `mcp.json` 中单个 server 的 `startupTimeoutMs`（默认 `30000`） | `1` 到 `2147483647` 的整数；非法值被忽略 |
| `KIKI_MCP_TOOL_TIMEOUT_MS` | 所有 MCP server 的全局默认单次工具调用超时（毫秒）；优先级高于 `config.toml` 的 `[mcp] tool_timeout_ms`，但低于 `mcp.json` 中单个 server 的 `toolTimeoutMs`（默认 `60000`） | `1` 到 `2147483647` 的整数；非法值被忽略 |
| `KIKI_LOOP_MAX_STEPS_PER_TURN` | Agent 单轮最大步数；优先级高于 `config.toml` 的 `[loop_control] max_steps_per_turn`（不设或 `0` 表示无上限） | 非负整数；非法值被忽略 |
| `KIKI_LOOP_MAX_ATTEMPTS_PER_STEP` | 单步失败后的最大总尝试次数（含首次尝试）；优先级高于 `config.toml` 的 `[loop_control] max_attempts_per_step`（默认 `5`） | 非负整数；非法值被忽略 |
| `KIKI_INFINITE_RETRY` | 让所有失败的 LLM 请求无限重试（包括轮次内步骤和 compaction 等后台操作）而不是终止任务；重试等待按指数退避（32 秒封顶）并尊重服务端 `Retry-After` 头，等待期间中断仍立即生效。适用于端点可能短暂故障的长时间无人值守评测 | 真值：`1`/`true`/`yes`/`on`；假值：`0`/`false`/`no`/`off` |
| `KIKI_TOKEN_COUNTING_STRATEGY` | 对外上报的上下文 token 计数（上下文大小显示）；优先级高于 `config.toml` 的 `[token_counting] strategy`（默认 `measured+estimated`） | `measured+estimated`、`measured`、`estimated`（不区分大小写）；非法值被忽略 |
| `NB_SEARCH_CONFIG` | 内置搜索与抓取模块的 canonical JSON 配置路径；Kiki 的 `[nb_search]` patch 在它之后应用 | 文件路径 |
| `NB_SEARCH_HOME` | 内置搜索与抓取模块的数据目录 | 目录路径 |
| `NB_SEARCH_JOBS_ROOT` | 内置搜索与抓取模块的持久化任务目录 | 目录路径 |
| `NB_SEARCH_LOG_LEVEL` | 内置搜索与抓取模块的日志级别 | `error`、`warn`、`info` 或 `debug` |
| `NB_SEARCH_RETENTION_HOURS` | 持久化 search 和 fetch 任务结果的保留时间 | 正整数 |
| `NB_SEARCH_EXA_API_KEY` | 内置 `exa.default` provider 实例使用的凭据 | 非空字符串 |
| `NB_SEARCH_TAVILY_API_KEY` | 内置 `tavily.default` provider 实例使用的凭据 | 非空字符串 |
| `NB_SEARCH_JINA_API_KEY` | 内置 `jina-reader.default` fetch provider 实例使用的可选凭据 | 非空字符串 |
| `KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE` | 是否在首轮结束后自动生成会话标题；优先于 `[experimental]` 条目和 `KIKI_EXPERIMENTAL_FLAG`（默认开启）——见 [`session_title`](./config-files.md#session-title) | 开启：`1`/`true`/`yes`/`on`；关闭：`0`/`false`/`no`/`off` |
| `KIKI_EXPERIMENTAL_FLAG` | 在当前进程启用所有已注册的实验功能；单个功能的 `KIKI_EXPERIMENTAL_<NAME>` 变量或 `config.toml` 的 `[experimental]` 节中的显式配置优先于它 | `1`、`true`、`yes`、`on` |
| `KIKI_SHELL_PATH` | Windows 上覆盖 Git Bash 路径（自动探测失败时使用） | 绝对路径 |
| `KIKI_MODEL_MAX_COMPLETION_TOKENS` | 单步 LLM 请求的 `max_completion_tokens` 硬上限，仅对 `kimi` 供应商生效 | 正整数；`0` 或负数禁用 clamp |
| `KIKI_MODEL_TEMPERATURE` | 每次请求的采样温度，仅对 `kimi` 供应商生效（全局生效，不依赖 `KIKI_MODEL_NAME`） | 数字，如 `0.3` |
| `KIKI_MODEL_TOP_P` | 每次请求的核采样 `top_p`，仅对 `kimi` 供应商生效（全局生效） | 数字，如 `0.95` |
| `KIKI_MODEL_THINKING_EFFORT` | 在线上强制使用指定的思考强度（`thinking.effort`），绕过模型声明的 `support_efforts`；仅对 `kimi` 供应商生效，且仅在 Thinking 开启时注入 | 思考强度值，如 `max` |
| `KIKI_MODEL_THINKING_KEEP` | 保留思考透传；在 `kimi` 上以 `thinking.keep` 发送，在 `anthropic`（Claude 以及 Kimi 的 Anthropic 兼容模式）上以 `context_management` 的 `clear_thinking_20251015` 编辑发送（开启 keep 会让 Anthropic 请求走 beta Messages API）；覆盖 `[thinking] keep`（其默认值为 `"all"`）；仅在 Thinking 开启时注入 | API 接受的值，如 `all`；传入关值（`false`/`0`/`no`/`off`/`none`/`null`）可禁用 |
| `KIKI_DISABLE_CRON` | 禁用定时任务工具（`CronCreate` 拒绝新计划，已有任务不触发） | `1` 表示禁用 |

subagent 并发没有环境变量覆盖。请在 [`[subagent]`](./config-files.md#subagent) 中配置 `max_direct_children` 和 `max_total_subagents`，默认值分别为 `16` 和 `0`（不限）。

`[subagent]` 曾经接受 `default_model` 与 `default_effort`；这两个键已被移除，写了不会生效，只会在启动时产生警告——subagent 的模型只来自派发参数或 profile pin，没有可回退的配置默认值（见 [`subagent`](./config-files.md#subagent)）。

## 诊断日志

这组变量控制日志级别和文件滚动，进程启动时读取一次：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIKI_LOG_LEVEL` | 日志级别：`off`、`error`、`warn`、`info`、`debug` | `info` |
| `KIKI_LOG_GLOBAL_MAX_BYTES` | 全局日志文件单个最大字节数 | `6291456`（6 MB） |
| `KIKI_LOG_GLOBAL_FILES` | 全局日志文件保留份数 | `5` |
| `KIKI_LOG_SESSION_MAX_BYTES` | 会话级日志文件单个最大字节数 | `5242880`（5 MB） |
| `KIKI_LOG_SESSION_FILES` | 会话级日志文件保留份数 | `3` |

## 系统环境变量

CLI 还会读取一些标准系统变量来检测运行环境，不会修改它们：

- `HOME`：解析默认数据路径
- `VISUAL`、`EDITOR`：外部编辑器命令（`VISUAL` 优先）
- `PATH`：定位 `rg`、`fd`、`fdfind`、`git` 等依赖；在 Windows 上，Git Bash 探测会检查 `PATH` 中找到的每个 `git.exe`，包括 Scoop 等包管理器提供的 shim
- `NO_COLOR`、`FORCE_COLOR`：控制颜色输出（遵循 [no-color.org](https://no-color.org) 约定）
- `CI`：非空且非 `"0"` 时关闭主题检测，回退深色主题
- `TERM_PROGRAM`、`TERM`、`TMUX`：检测终端特性和通知支持
- `DISPLAY`、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`：检测 Linux 图形会话（用于剪贴板和图片功能）
- `WSL_DISTRO_NAME`、`WSLENV`：检测 WSL，用于剪贴板 PowerShell 桥接
- `LOCALAPPDATA`：Windows 上探测 Git Bash 安装路径时作为 fallback 使用

## HTTP 代理

Kiki 会遵循标准代理环境变量，让所有出网流量——模型 API 调用、MCP 服务、网络工具、登录、更新检查——都走代理：

- `HTTP_PROXY` / `http_proxy`：用于 `http://` 请求的代理
- `HTTPS_PROXY` / `https_proxy`：用于 `https://` 请求的代理
- `ALL_PROXY` / `all_proxy`：当对应 scheme 的变量未设置时使用的兜底代理；SOCKS 代理通常设在这里
- `NO_PROXY` / `no_proxy`：以逗号分隔的、绕过代理的主机列表

同时支持 HTTP(S) 代理和 SOCKS 代理。SOCKS 代理通过 scheme 识别——`socks5://`、`socks5h://`、`socks4://` 或 `socks://`（`socks5://` 的别名）——通常设在 `ALL_PROXY`（Clash、V2RayN 等工具使用的形式）。对 HTTP/HTTPS 流量，HTTP(S) 代理优先于 `ALL_PROXY`。

仅当设置了其中任一变量时才启用代理，否则直连。回环地址（`localhost`、`127.0.0.1`、`::1`）始终绕过代理，因此配置了代理后，本地服务（例如 localhost 上的 MCP 服务）仍能正常工作——你也可以把自己的内网主机加入 `NO_PROXY` 一并放行。

以 Node 子进程运行的 stdio MCP 服务，在其 Node 版本支持 `NODE_USE_ENV_PROXY` 时（Node ≥ 22.21 或 ≥ 24.5）会自动遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`；SOCKS 代理仅作用于 Kiki 自身的流量。

## 下一步

- [配置覆盖](./overrides.md) — 环境变量、CLI 选项、配置文件的优先级关系
- [数据路径](./data-locations.md) — `KIKI_HOME` 影响的完整目录结构
- [平台与模型](./providers.md) — 各供应商类型的完整接入示例
