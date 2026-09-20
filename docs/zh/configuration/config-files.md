# 配置文件

Kiki 把所有长期偏好写进 `~/.kiki/` 下的 TOML（一种结构清晰的纯文本配置格式）文件——比如使用哪个模型、填哪个 API 密钥、Agent 每轮最多跑几步。改一次，每次启动都生效。Agent 与运行时设置放在 `config.toml`，终端界面与客户端偏好（主题、编辑器、通知、自动更新）放在配套的 `tui.toml`。

默认位置：`~/.kiki/config.toml`，首次运行时自动创建。

## 配置文件位置

CLI 从 `~/.kiki/config.toml` 读取配置。如需把数据目录迁移到别处，可用 `KIKI_HOME` 环境变量覆盖：

```sh
export KIKI_HOME=/path/to/kiki-home
```

此时配置文件路径变为 `$KIKI_HOME/config.toml`。无论目录在哪里，文件名固定是 `config.toml`。

::: tip
TOML 字段名一律用下划线（snake_case），如 `default_model`、`max_context_size`。字段名里若含 `.`，需用引号包住，例如 `[models."gpt-4.1"]`——否则 TOML 会把 `.` 解释为嵌套表分隔符。
:::

## 完整示例

以下示例覆盖最常用的配置项，可直接复制后按需修改：

```toml
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[thinking]
enabled = true
effort = "high"
keep = "all"

[loop_control]
max_attempts_per_step = 10
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false

[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "NB_SEARCH_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kiki/hooks/check-bash.mjs"
timeout = 5
```

## 顶层字段

配置文件里的字段分两类：**顶层标量**直接控制默认行为，**嵌套表**（`providers`、`models`、`thinking` 等）各有独立结构，在下文各节单独说明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_model` | `string` | — | 默认模型别名，必须在 `models` 中定义 |
| `default_permission_mode` | `string` | `manual` | 新会话的默认权限模式，可选 `manual`（逐次询问）、`yolo`（自动批准工具操作，Agent 仍可能提问）、`auto`（完全自主，Agent 自己做决定，不再提问） |
| `default_plan_mode` | `boolean` | `false` | 新会话是否默认以 Plan 模式（先出计划再执行）启动 |
| `merge_all_available_skills` | `boolean` | `true` | 是否合并所有目录中的 Agent Skills |
| `extra_skill_dirs` | `array<string>` | — | 额外 Skill 搜索目录，叠加到默认目录之上 |
| `extra_agent_dirs` | `array<string>` | — | 额外自定义 Agent 搜索目录，叠加到默认目录之上 |
| `skip_builtin_profile_installation` | `array<string>` | — | 启动时不安装到 `agents/builtin/` 的内置模板名称。已有受管理副本仍可使用并继续接收安全更新；它不是运行时禁用开关。只要声明了此键（包括 `[]`），就优先于下面的弃用别名 |
| `disabled_builtin_profiles` | `array<string>` | `[]` | `skip_builtin_profile_installation` 的弃用别名；新键缺失时仍会读取，并产生迁移警告。保留列表内容、重命名键即可 |
| `disabled_named_profiles` | `array<string>` | `[]` | 从 subagent 发现与派发列表中隐藏的 profile 名称，不区分文件来源。默认 main `agent` 绑定仍可使用 |
| `builtin_product_skills` | `boolean` | `true` | 是否向模型提供 Kiki 产品 Skills：`kiki-ops` 负责产品使用与配置，`kiki-profile` 负责创建和修改 agent profile。关闭后两者的名称和描述都不再进入系统提示词，代价是失去这些任务的引导流程 |
| `providers` | `table` | `{}` | API 供应商表 → [`providers`](#providers) |
| `models` | `table` | — | 模型别名表 → [`models`](#models) |
| `thinking` | `table` | — | Thinking 模式默认参数 → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent 循环控制参数 → [`loop_control`](#loop-control) |
| `retry` | `table` | — | 按错误定制的单步重试策略 → [`retry`](#retry) |
| `token_counting` | `table` | — | 对外上报哪种上下文 token 计数 → [`token_counting`](#token-counting) |
| `background` | `table` | — | 后台任务运行参数 → [`background`](#background) |
| `subagent` | `table` | — | subagent 运行默认值与限额 → [`subagent`](#subagent) |
| `agents` | `table` | — | 委派说明默认值 → [`agents`](#agents) |
| `thread_communication` | `table` | `{ enabled = false }` | 本地 peer thread 通信 → [`thread_communication`](#thread-communication) |
| `mcp` | `table` | — | MCP server 全局超时默认值 → [`mcp`](#mcp) |
| `tools` | `table` | — | 全局工具开关 → [`tools`](#tools) |
| `image` | `table` | — | 图片压缩参数 → [`image`](#image) |
| `session_title` | `table` | — | 由哪个模型生成会话标题 → [`session_title`](#session-title) |
| `experimental` | `table` | — | 实验功能 flag 的持久化覆盖 → [`experimental`](#experimental) |
| `nb_search_source` | `table` | — | 宿主选项：内置搜索模块是否复用服务器本机的 nb-search 配置 → [`nb_search`](#nb-search) |
| `nb_search` | `table` | — | `WebSearch` 与 `FetchURL` 背后的内置搜索与抓取模块 → [`nb_search`](#nb-search) |
| `permission` | `table` | — | 初始权限规则 → [`permission`](#permission) |
| `hooks` | `array<table>` | — | 生命周期 hook，详见 [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | 自定义 Agent 身份 → [`identity`](#identity) |
| `prompt` | `table` | `{}` | 提示词字段覆写与自定义变量 → [`prompt`](#prompt) |

以下各节对 `providers`、`models`、`thinking`、`loop_control`、`retry`、`token_counting`、`background`、`subagent`、`agents`、`thread_communication`、`mcp`、`tools`、`image`、`session_title`、`experimental`、`nb_search`、`permission`、`prompt` 等嵌套表逐一展开。

## `providers`

`providers` 表的每一项定义一个 API 供应商，以唯一名称为 key。CLI 只从这里读取凭证，**不会**从 shell 环境变量自动取后备值——在终端里 `export KIMI_API_KEY` 不会让供应商自动获得密钥，必须显式写在配置文件里（详见[配置覆盖](./overrides.md#供应商凭证)）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型：`kimi`、`anthropic`、`openai`、`openai_responses`、`google-genai`、`vertexai` |
| `api_key` | `string` | 否 | API 密钥，明文写在配置文件里 |
| `base_url` | `string` | 否 | API 基础 URL |
| `oauth` | `table` | 否 | OAuth 凭据引用（`storage`、`key` 两个字段），由登录流程自动注入，通常无需手写 |
| `env` | `table<string, string>` | 否 | 供应商凭证的备用来源，详见下文 |
| `custom_headers` | `table<string, string>` | 否 | 每次请求附加的自定义 HTTP 头 |

**`env` 子表**：可以把供应商惯用的键名（如 `KIMI_API_KEY`）写在 `[providers.<name>.env]` 里，作为 `api_key` / `base_url` 的备用来源。这个子表**只在配置文件里读取**，不会修改 shell 环境：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

优先级：`api_key` 字段 > `env` 子表键 > 两者都缺时启动报错。

## `models`

`models` 表的每一项定义一个模型别名（即 `default_model` 或 `-m` 参数里使用的名称），以唯一名称为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 调用 API 时实际传给服务端的模型 ID |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数），必须 ≥ 1 |
| `max_input_size` | `integer` | 否 | 模型声明的单次请求输入上限（当低于总窗口时，如 gpt-5 的 400k 窗口 / 272k 输入）。压缩、上下文溢出检查和用量比率优先使用它；补全预算仍使用总窗口。解析时会被钳制到不超过 `max_context_size` |
| `max_output_size` | `integer` | 否 | 单次请求的输出 token 上限（对应 `max_tokens`）。目前仅 `anthropic` 供应商读取。为 Claude 模型设置后，这个显式值会覆盖内置的服务端最大值 |
| `capabilities` | `array<string>` | 否 | 显式追加的能力标签：`thinking`、`always_thinking`、`image_in`、`video_in`、`audio_in`、`tool_use`。与供应商自动识别的能力取并集，只能追加不能移除 |
| `support_efforts` | `array<string>` | 否 | 模型接受的 Thinking 档位。对 `kimi` 而言，在运行时选择列表外的值会报错；模型解析时若配置值或之前的值不受目标模型支持，会回落到目标模型的 `default_effort`，并将该有效值同步给 UI。支持 Thinking 但没有此字段的 Kimi 模型使用布尔 `on` / `off`。其他 provider 在协议提供原生 effort 字段时会原样传递具体值；协议仅提供等级或 token budget 时，只做必要的格式转换。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] support_efforts` |
| `default_effort` | `string` | 否 | 模型的默认 Thinking 档位。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] default_effort` |
| `service_tier` | `string` | 否 | 使用此模型的每个请求采用的服务档位：`auto`、`default`、`flex` 或 `priority`。优先于 profile、route 和单次请求的档位，对主 Agent 和子 Agent 均生效。只有 `openai_responses` 会编码此字段，其他协议忽略它；省略时保留 profile 或单次请求的档位 |
| `request_params` | `table` | 否 | 合并进该模型每次请求的额外请求参数（如 `temperature`、`top_p`）；取值可为字符串、数字或布尔值。跨层时按键合并 |
| `context_budget` | `integer` | 否 | 该模型有效上下文窗口的 token 上限；不会超过模型真实容量。跨层取最小值 |
| `max_completion_tokens` | `integer` | 否 | 单次请求补全 token 的上限。跨层取最小值，且受模型输出上限约束 |
| `off_effort` | `string` | 否 | 关闭 Thinking 时在线上传输的 effort 编码（如 xai grok 的 `none`）。仅对声明了该编码的模型（catalog 会导入）有意义：设置后选择 Off 会发送这个值而不是省略 effort 字段——对默认就会推理的模型，这是真正关闭推理的唯一方式 |
| `protocol` | `string` | 否 | 传输层覆盖；目前仅支持 `anthropic`，将此模型的请求路由到 Anthropic Messages 传输层。不接受写入 `overrides` |
| `beta_api` | `boolean` | 否 | 仅 `anthropic` 传输层：让请求走 beta Messages API 端点而不是标准端点。不接受写入 `overrides` |
| `base_url` | `string` | 否 | 模型级端点覆盖（catalog 导入网关模型时写入，这些模型与供应商默认端点不同）。解析时优先于供应商的 `base_url`；仅在与 `protocol` 配合时生效 |
| `display_name` | `string` | 否 | UI 中显示的名称，未设时回退到 `model` |
| `aliases` | `array<string>` | 否 | 该模型的额外路由键。任意一项精确匹配都会解析到这个表键，包含 `/` 的旧名称也可以。这是重命名表键后让旧名称继续可用的正规做法。两个模型声明同一段 alias 字符串会报错 |
| `reasoning_key` | `string` | 否 | 仅 `openai` 供应商。当网关用非标准字段名返回推理内容时才需要设置；默认自动识别 `reasoning_content` / `reasoning_details` / `reasoning` |
| `adaptive_thinking` | `boolean` | 否 | 仅 `anthropic` 供应商。强制开启或关闭 adaptive thinking，覆盖按模型名推断的逻辑。省略时自动推断（Claude ≥ 4.6 使用 adaptive） |
| `prompt_overrides` | `table` | 否 | 该模型 alias 的提示词字段覆写，可含 `files` 与 `fields`；详见 [`prompt`](#prompt) |
| `cognition` | `table` | 否 | 挂到该模型别名上的提示词文件 → [模型认知](#模型认知) |

别名中含 `.` 时需要加引号：

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1048576
```

### 模型别名解析

`[models]` 每一项的键就是模型别名——`default_model`、`-m` 以及 Agent 的 `model_alias` 用的都是这个名字。请求按下面的顺序解析：

1. 精确的表键
2. 与某条模型的 `aliases` 列表精确匹配
3. 无歧义的裸名，匹配表键或记录的 `model` 字段（相等，或以 `/<name>` 结尾）
4. 带供应商前缀的名称（`<prefix>/<name>`）：最后一段是表键，且前缀与该记录的 `provider` 一致

在匹配唯一时，裸名和带供应商前缀的名称可以互相解析。若有多个已配置模型同时匹配，解析会失败，并提示使用完整模型 id 来消歧。

缩短表键之后，把旧名称写进 `aliases`，会话和 Agent profile 里仍保存旧名的地方就能继续工作：

```toml
[models.fast-model]
provider = "openai"
model = "fast-model"
max_context_size = 1048576
aliases = ["openai/fast-model"]
```

审查用模型也一样，如果旧键带供应商前缀：

```toml
[models.k3-review]
provider = "openai"
model = "k3-review"
max_context_size = 262144
aliases = ["openai/k3-review"]
```

### 模型覆盖项

如果某些用户覆盖需要在 provider-model 刷新后保留，请写到 `[models."<alias>".overrides]`。运行时读取的是 effective 值：有 override 时用 override，否则用顶层字段。

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` 接受普通模型字段，例如 `max_context_size`、`max_input_size`、`max_output_size`、`capabilities`、`display_name`、`reasoning_key`、`adaptive_thinking`、`support_efforts`、`default_effort`、`off_effort`、`service_tier`、`request_params`、`context_budget` 与 `max_completion_tokens`。不接受身份 / 路由字段：`provider`、`model`、`protocol`、`beta_api` 和 `base_url`。对这些新增字段，先得到模型 alias 的有效配置（包括其 `overrides`），再按 "模型 alias → profile 顶层 → 命中的 `model_profiles` 条目" 合并：`request_params` 逐键覆盖，`service_tier` 使用最后一个明确值；`context_budget` 和 `max_completion_tokens` 是限制，取各层声明值的最小值，并继续受模型容量与输出上限约束。省略限制表示不增加限制。

无需修改配置文件也可以临时切换模型——通过 `KIMI_MODEL_*` 环境变量在内存里合成一个临时供应商，详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。

### 模型认知

`[models."<alias>".cognition]` 把提示词文件挂到单个模型别名上，这样 catalog 里某个需要不同调节（用来塑造推理方式的额外指令）的模型就能单独拿到，而不必改任何 Agent profile。每个字段都指向运行时从磁盘读取的文件；CLI 不附带任何默认正文，未声明文件时也不会注入任何内容。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `overlay` | `string` 或 `array<string>` | — | 合并进所绑定模型系统提示词的文件。多条路径按声明顺序以空行拼接 |
| `overlay_mode` | `string` | `append` | `overlay` 与 profile 提示词的组合方式：`append`、`prepend`、`wrap`、`persona` 或 `replace` |
| `steering` | `string` 或 `array<string>` | — | 作为 User 消息、紧接在你的提示词之后、在每一轮开头注入的文件 |
| `anchor` | `string` 或 `array<string>` | — | 用作一轮开头若干步的完整系统提示词的文件，会替换 profile 提示词以及任何 `overlay` |
| `anchor_steps` | `integer` | `1` | 被锚定的一轮开头有多少次模型请求使用 `anchor` 正文；必须至少为 1 |
| `anchor_scope` | `string` | `session` | `session` 只锚定会话的第一轮；`turn` 锚定每一轮的开头若干步 |

路径相对于[数据根目录](./data-locations.md#数据根目录)（默认为 `~/.kiki`）。绝对路径、解析后落到数据根之外的路径（包括经由符号链接）以及缺失的文件，会在 profile 绑定时被拒绝，错误信息会标出字段和路径——写错路径会让会话停下来，而不是静默送出未经调节的提示词。已声明且存在但内容为空的文件会被跳过；某个字段声明的文件全部为空时，该字段视为未设置。

三个字段离模型下一个 token 的远近不同。`overlay` 和 `anchor` 改写系统提示词，模型在你的请求之前只读一次。`steering` 紧接在你的提示词之后，作为普通 User 消息注入——不是 `<system-reminder>`——并且每一轮新开始时都会重新注入同一段正文，压缩后重新装填上下文时也一样，因此这条提示不会从最近一次请求旁边漂走。

`overlay_mode` 决定 profile 提示词还剩多少：

| 模式 | 结果 |
| --- | --- |
| `append` | 先是 profile 提示词，然后是 overlay |
| `prepend` | 先是 overlay，然后是 profile 提示词 |
| `wrap` | overlay、profile 提示词，然后是一句固定收尾，声明 overlay 仍支配推理 |
| `persona` | overlay 替换 profile 提示词开头的 `You are …` 段落；该提示词的其余部分保留 |
| `replace` | overlay 成为完整的系统提示词 |

`persona` 通过匹配提示词最开头的 `You are` 来定位身份段落。提示词以其他方式开头的 profile 没有可替换的身份段落，此时改为把 overlay 追加到末尾。

锚定是按请求替换，而不是改写已存储的提示词。被锚定的一轮里，前 `anchor_steps` 次请求会把 `anchor` 正文当作完整系统提示词发给模型；从下一步起直到会话结束，模型收到的是含 overlay 在内的常规提示词。适合用在这种场景：冗长的 profile 提示词挤掉了你希望模型在规划当下看到的调节内容，而完整提示词只在它开始工具调用之后才重要。调用方显式传入的系统提示词永远不会被替换。

模型认知绑定在别名上，而不是主 Agent 上，因此绑到同一别名的子 Agent（无论该别名来自 profile pin 还是派发参数）都会拿到同一套 overlay、steering 和 anchor。会话中途切换别名会为新绑定的模型重新渲染 overlay。

下面的例子给一个 DeepSeek V4 模型做调节：它默认习惯逐步叙述执行过程，而不是先规划。短 `anchor` 是一层精简 persona，在模型规划时顶替 profile 提示词；再配上要求先规划再行动的 `steering`：

```toml
[models."axon-message/deepseek-v4-flash-0731".cognition]
anchor = "cognition/flash-anchor.md"
anchor_steps = 3
steering = "cognition/flash-steering.md"
```

`~/.kiki/cognition/flash-anchor.md`：

```
You are a helpful software engineer assistant.
```

`~/.kiki/cognition/flash-steering.md`：

```
Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Let's first understand the problem and devise a plan; then let's carry out the plan and act.
```

两个文件都就位后，模型会在会话的前三步先规划再行动，随后继续使用完整的 profile 提示词。

把那段措辞当作起点，而不是一项设置。哪种表述真能改变模型的推理，是在这一个模型上测出来的；另一个模型——或另一份 profile 提示词——可能需要不同的正文，也可能完全不需要。机制本身并不解读这些文件。

## 子 Agent 的模型绑定

子 Agent 的模型只有两个来源：通过 `AgentRun` 派发时传入的 `model_alias`，或所选 profile、route、caller lease 上的 pin。
没有第三个来源——子 Agent 不会跑在调用方的模型上，也没有可回退的配置默认值。
既没有传 `model_alias`、所选 profile 又没有 pin 的派发会以 `model.not_configured`
失败，子 Agent 不会被创建。

thinking effort 同样按"工具 `effort` → profile `thinking_effort`"解析，但允许留空：
留空时使用全局 [`[thinking]`](#thinking) 配置与所绑定模型自身的默认档位。

## `thinking`

`thinking` 设置 Thinking 模式的全局默认行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 新会话是否默认开启 Thinking，设为 `false` 可强制关闭 |
| `effort` | `string` | — | Thinking 强度（例如 `low`、`medium`、`high`、`xhigh`、`max`）。非 Kimi provider 在上游协议接受具体 effort 值时不会改写该值；如果上游拒绝，请改成该模型支持的档位。协议仅提供等级或 token budget 时，仍需做格式转换。对于带 `support_efforts` 的 Kimi 模型，若该配置值不在列表中，会回落到模型默认档位；没有该列表的 Kimi 模型会把任意开启值视为布尔 `on` |
| `keep` | `string` | `"all"` | 保留思考透传。在 `kimi` 上以 `thinking.keep` 发送；在 `anthropic`（Claude 以及 Kimi 的 Anthropic 兼容模式）上以 `context_management` 的 `clear_thinking_20251015` 编辑发送（开启 keep 会让 Anthropic 请求走 beta Messages API；关值可禁用 keep 并回到标准端点）。`"all"` 会保留历史轮次的思考内容（`reasoning_content` / Anthropic thinking blocks）；传入关值（`false`/`0`/`no`/`off`/`none`/`null`）可禁用。可被 `KIMI_MODEL_THINKING_KEEP` 覆盖；仅在 Thinking 开启时注入 |

### 已废弃字段

| 字段 | 废弃版本 | 描述 |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | 顶层布尔值，由 `[thinking] enabled` 取代。将 `default_thinking = true` 迁移为 `enabled = true`，`default_thinking = false` 迁移为 `enabled = false`。 |
| `thinking.mode` | 0.21.0 | 可选值 `auto` / `on` / `off`，由 `[thinking] enabled` 取代。`mode = "off"` 改为 `enabled = false`；`mode = "on"` 和 `mode = "auto"` 等价于 `enabled = true`（默认值），可删除该行。 |
| `loop_control.max_retries_per_step` | 0.32.0 | 由 `loop_control.max_attempts_per_step` 取代（该值本来就是含首次尝试的总尝试次数上限）。旧 key 不再生效，启动时会给出警告，请在 `config.toml` 中手动改名。 |
| `loop_control.max_steps_per_run` | 0.32.0 | 由 `loop_control.max_steps_per_turn` 取代。旧 key 不再生效，启动时会给出警告，请在 `config.toml` 中手动改名。 |

## `loop_control`

`loop_control` 控制 Agent 执行循环的步数上限、单步尝试次数上限、触发上下文自动压缩的阈值，以及压缩请求失败后的尝试次数上限。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | 单轮最大步数；不设或设为 `0` 则无上限 |
| `max_attempts_per_step` | `integer` | `10` | 单步失败后的最大总尝试次数（含首次尝试） |
| `reserved_context_size` | `integer` | — | 预留给模型输出的 token 数；上下文窗口剩余量低于此值时触发自动压缩 |
| `compaction_max_attempts` | `integer` | `5` | 压缩失败后的最大总请求次数（含首次请求）；重试退避、上下文超限收缩、空响应或截断收缩等所有恢复路径共用同一份预算 |

`max_steps_per_turn` 可被环境变量 `KIMI_LOOP_MAX_STEPS_PER_TURN` 覆盖，`max_attempts_per_step` 可被 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` 覆盖，优先级均高于配置文件。旧的 `KIMI_LOOP_MAX_RETRIES_PER_STEP` 已废弃，但在新变量未设置时仍生效（启动时会给出警告）。

重试仅针对瞬时故障——连接错误、超时、HTTP 429 限流和 5xx 服务端错误。账户额度耗尽或余额不足导致的 429 不会重试，会立即失败：在充值之前重试不可能成功。

## `retry`

`retry` 可为指定的单步错误定制总尝试次数与固定退避时间。本节及每条策略都是严格配置：未知字段会被拒绝，不会静默忽略。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_attempts` | `integer` | — | 单步失败后的最大总尝试次数（含首次尝试）；优先于 `loop_control.max_attempts_per_step` |
| `policies` | `array<table>` | — | 用 `[[retry.policies]]` 编写的有序逐错误策略；首个命中的策略生效 |

每条 `[[retry.policies]]` 包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `match` | `string` | 是 | 与错误码和错误名称匹配的正则表达式（按模式匹配文本的规则） |
| `max_attempts` | `integer` | 否 | 命中错误的最大总尝试次数（含首次尝试）；优先于本节的总预算 |
| `backoff` | `integer` | 否 | 每次重试前固定等待的毫秒数；provider 返回的 retry-after 提示仍优先 |
| `retry` | `boolean` | 否 | 默认为 `true`。`false` 可抑制 Kiki 内建判定原本会重试的错误；`true` 不能强制重试被判定为不可重试的错误 |

策略从上到下检查，因此应把更具体的正则表达式放在更宽泛的规则之前：

```toml
[retry]
max_attempts = 4

[[retry.policies]]
match = '^provider\.rate_limit$'
max_attempts = 6
backoff = 1000

[[retry.policies]]
match = '^provider\.'
retry = false
```

## `token_counting`

`token_counting` 决定对外上报的上下文 token 计数——即上下文大小显示所基于的值。内部逻辑（自动压缩触发、预算、超限退避）始终同时使用供应商实测与估算，不受本配置影响。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` 上报实时大小——每次请求的供应商实测用量加上未实测尾部的估算——并以最近一次实测总量兜底；`measured` 只上报供应商实测，显示仅在每次请求完成后变化；`estimated` 忽略供应商实测、上报纯估算——适用于不上报用量或用量不可信的供应商 |

`strategy` 可被环境变量 `KIMI_TOKEN_COUNTING_STRATEGY` 覆盖，优先级高于 `config.toml`。

## `background`

`background` 控制后台任务（通过 `Bash` 工具的 `run_in_background=true` 参数，或 `AgentRun` 工具的 `background=true` 参数启动）的并发数。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `false` | 会话关闭时是否保留仍在运行的后台任务。默认情况下，Kiki 会在进程退出前请求停止所有后台任务；只有希望任务在会话结束后继续运行时才设为 `true`。在 print 模式（`kiki -p`）下，本字段仅作为 `print_background_mode` 未设置时的兼容回退：`true` 等价于 `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | 会话关闭、手动停止或任务超时请求正常终止后，等待任务自行结束的宽限时间（毫秒）。超过该时间仍在运行时，Kiki 会尝试强制停止该任务 |
| `bash_auto_background_on_timeout` | `boolean` | `true` | 前台 `Bash` 命令触及超时时间时，将其转为后台任务而不是直接终止：命令完成时 agent 会收到通知，转入后台的命令受 `bash_task_timeout_s` 默认后台超时约束。设为 `false` 则恢复超时即终止的行为 |
| `bash_task_timeout_s` | `integer` | `600` | 后台 `Bash` 任务在调用未传 `timeout` 时的默认超时（秒）；前台命令超时转后台后也按此值重新计时。`0` 表示无超时——任务一直运行到自行结束或被模型手动停止。显式传入的 `timeout` 不受影响。在 print 模式（`kiki -p`）下未显式设置时默认为 `0` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | 仅 print 模式（`kiki -p`）生效，决定 main agent 的 turn 结束后如何处理未返回的后台任务：`"exit"` 立即退出；`"drain"` 退出前等待所有后台任务进入终态（结果不回馈给 main agent）；`"steer"` 不退出，让后台任务完成时像后台 subagent 一样以合成 user 消息 steer main agent 进入新 turn，直到某 turn 结束时无未决后台任务或触及上限。设置后优先级高于 `keep_alive_on_exit` 的 print 回退 |
| `print_wait_ceiling_s` | `integer` | `2147483` | print 模式（`kiki -p`）下，`print_background_mode` 为 `"drain"` 或 `"steer"` 时，等待/steer 循环的墙钟上限（秒；默认约 24.8 天，近似不设限）。在非 print 模式或 `"exit"` 时无效 |
| `print_max_turns` | `integer` | `100000` | print 模式（`kiki -p`）且 `print_background_mode = "steer"` 时，允许由后台任务完成触发的新 turn 的最大数量，防止 steer 循环失控（默认值近似不设限） |

`keep_alive_on_exit` 可被环境变量 `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖，`max_running_tasks` 可被 `KIKI_BACKGROUND_MAX_RUNNING_TASKS` 覆盖，优先级均高于配置文件。

在 print 模式（`kiki -p "<prompt>"`）下，只要还有未决的后台任务，Kiki 在 main agent 的 turn 结束后不会退出：每个任务完成都会以合成 user 消息回馈给 main agent，steer 出新的 turn（默认 `print_background_mode = "steer"`），直到某 turn 结束时没有任何未决任务才退出。该循环受 `print_wait_ceiling_s` 与 `print_max_turns` 约束，默认值都近似不设限。print 模式下后台工作也不会被墙钟超时杀掉：后台 `Bash` 任务默认无超时（`bash_task_timeout_s = 0`），subagent 默认无超时（`[subagent] timeout_ms = 0`），只有模型自己能停止任务。将 `print_background_mode` 设为 `"drain"` 可等待任务结束但不回馈结果，设为 `"exit"` 则在 main agent 结束后立即退出。

## `subagent`

`subagent` 控制派生 subagent（`AgentRun`）的运行方式。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_profile` | `string` | `general` | `AgentRun` 省略 `profile`、`route` 和 `profile_file` 时采用的目标 profile。即使 `[subagent]` 只配置了部分字段，缺失字段仍继承此默认值。设为 `""` 才要求显式指定目标（严格模式） |
| `deny_models` | `string[]` | — | alias 解析后应用于所有 subagent 模型绑定的黑名单，无论该 alias 来自派发参数还是 profile pin |
| `max_direct_children` | `integer` | `16` | 每个派遣者同时在途的直属子 Agent 执行数上限，包括启动中和取消中；`0` 表示不限 |
| `max_total_subagents` | `integer` | `0` | 单棵会话树同时在途的子 Agent 执行总数上限，包括孙代及更深后代，不含 main；`0` 表示不限 |
| `timeout_ms` | `integer` | `7200000`（2 小时） | 单个 subagent（`AgentRun`）允许运行的最长时间（毫秒）。超时后 subagent 以 `timed_out` 收尾。`0` 表示无超时——subagent 一直运行到自行结束或被模型手动停止。该值是后台任务管理器对每个 subagent 任务的 per-task timeout，因此对前台与后台 subagent 同时生效。在 print 模式（`kiki -p`）下未显式设置时默认为 `0`。注意：超过 `2147483647`（约 24.8 天）的值会被运行时钳到约 24.8 天 |

`timeout_ms` 可被环境变量 `KIMI_SUBAGENT_TIMEOUT_MS` 覆盖，优先级高于配置文件。`deny_models` 和两个并发限额没有对应的环境变量。

限额是全局配置默认值，计数则按会话隔离。空闲子 Agent 和历史记录不计数；父 Agent 结束后仍运行的后代继续计数。恢复已有子 Agent 会占用执行名额，不会重复创建 Agent。派遣在异步启动前占位，启动失败或执行真正结束后释放。触及任一层上限会立即返回 `dispatch.limit_exceeded`，附带 `layer`、`current`、`limit`、`owner`（REST 业务码为 `42904`），不会排队或停止其他 Agent。可等待正在执行的任务结束，或显式调高对应配置限额。任务完成后的自动唤醒也遵守相同限额；唤醒被拒绝时，已完成任务及其输出仍可通过 `TaskOutput` 读取，通知不会被标记为已送达。

## `agents`

这个严格配置节控制[委派说明](../customization/agents.md)的布尔 gate。未知字段会被报告为配置错误。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 为配置兼容而保留，目前不控制任何行为 |
| `notify_parent` | `boolean` | `true` | 允许仅 subagent 可用的 `AgentNotify` 工具——向父 Agent 的邮箱排入一条 fire-and-forget 消息。设为 `false` 后所有 subagent 都不再获得该工具 |

`[agents.delegation]` 是嵌套表，两个槽位都只接受 boolean。`false` 会跳过对应说明，并始终优先于提示词字段覆写；省略槽位或设为 `true` 都表示启用说明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sub` | `boolean` | `true` | 启用该 profile 作为被派发 subagent 运行时注入的说明 |
| `independent` | `boolean` | `true` | 启用 MCP / SDK 这类没有父 Agent 的宿主调用说明 |

如需替换说明文案，在 [`PromptOverrides`](#prompt) 中覆写 `delegation.sub.notice` 或 `delegation.independent.notice`。旧的字符串路径值已经移除，继续使用会触发严格解析错误；请把原文件正文迁入外部提示词覆写 TOML 的 `[fields]` 条目。

## `thread_communication`

这个严格配置节控制[本地 peer thread 通信](../customization/agents.md#peer-thread-通信)。功能默认关闭，没有对应的环境变量覆盖。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | 允许 4 个主 Agent peer thread 工具以及本地 REST 与 Klient thread 操作；设为 `true` 可全局启用这些操作 |

单个工作区的覆盖值单独持久化，通过本地 REST API 或 Klient 管理。全局开关开启时，覆盖值可以关闭某个工作区；全局开关关闭时，覆盖值不能重新启用通信。

## `mcp`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000`（30 秒） | 所有 MCP server 的全局默认连接（启动 + 工具发现）超时（毫秒），取值范围为 `1`–`2147483647`。`mcp.json` 中单个 server 的 `startupTimeoutMs` 始终优先于本节与环境变量；都未设置时使用默认值 |
| `tool_timeout_ms` | `integer` | `60000`（60 秒） | 所有 MCP server 的全局默认单次工具调用超时（毫秒），取值范围为 `1`–`2147483647`。`mcp.json` 中单个 server 的 `toolTimeoutMs` 始终优先于本节与环境变量；都未设置时使用客户端内置默认值 |

`startup_timeout_ms` 和 `tool_timeout_ms` 可分别被环境变量 `KIKI_MCP_STARTUP_TIMEOUT_MS` 和 `KIKI_MCP_TOOL_TIMEOUT_MS` 覆盖，优先级高于配置文件。MCP server 的完整配置方式见 [MCP](../server/mcp.md)。

## `identity`

自定义 Agent 的身份标识。不设置时行为完全不变。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | — | Agent 在系统提示词中的自称（填充 `${product_name}` 变量，你自己的 `SYSTEM.md` 和 agent 文件同样适用） |
| `slug` | `string` | 由 `name` 派生 | 协议字段中使用的机器标识：发给第三方 provider 的 `User-Agent` 产品名，以及连接 MCP 服务器时声明的客户端名。省略时由 `name` 派生：转小写，连续的非字母数字字符折叠为 `-` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"        # 可选
```

两个字段都可以通过 `KIKI_IDENTITY_NAME` 和 `KIKI_IDENTITY_SLUG` 环境变量设置，优先级高于 `config.toml`，且不会被写回配置文件——适合不便写配置文件的容器和 CI 场景。

如果名称中不含任何 ASCII 字母或数字（例如纯中文名称），就无法派生出 slug，此时回退为 `agent`；需要特定协议标识请显式填写 `slug`。

身份在启动时解析一次，进程生命周期内保持不变——建立连接时它已宣告给 MCP 服务器和 provider，中途无法更换。修改本节配置在下次启动时对新会话生效；resume 的会话保留录制时的系统提示词，因为其历史轮次本就以原身份自称。同理，已完成的 MCP OAuth 授权保留其授予时的客户端注册；重置该服务器的认证即可在新身份下重新注册。
## `tools`

`tools` 设置全局工具开关，对所有会话中的每个 Agent 生效，并在 Agent 自身的 `tools` / `disallowedTools` 策略之上再取一次交集。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | 全局允许列表：非空时仅列出的工具可用；省略或设为空数组均表示不约束 |
| `disabled` | `array<string>` | — | 全局禁止列表，在 `enabled` 之后应用 |

工具名匹配规则与 Agent 文件中的同名字段一致：内置工具按名称精确匹配（如 `Read`），MCP 工具用 glob 匹配（如 `mcp__github__*`）。有三种写法永远匹配不到任何工具，出现时会给出警告：`mcp__` 模式之外使用通配符（`enabled = ["*"]` 会禁用所有工具，而 `disabled = ["*"]` 什么也禁不掉）；缺少工具段的 `mcp__` 字面量（`mcp__github` —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（匹配区分大小写）。

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

::: warning 注意
与 Agent 文件中的 `tools` / `disallowedTools` 一样，本节不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。[权限规则](#permission)仍是独立的控制层，用于决定哪些操作需要审批。
:::

## `image`

`image` 控制图片发送给模型前的压缩行为，对所有图片入口生效（粘贴图片、`ReadMediaFile` 读图、MCP 工具结果里的图片等）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | 图片最长边上限（像素）。超过时按比例缩小到该值以内；调大可保留更多细节，代价是更大的请求体积 |
| `read_byte_budget` | `integer` | `262144`（256 KB） | 模型自行读取的图片（`ReadMediaFile` 默认读取）的单图字节预算。会话中模型反复截图、读图时，累计请求体大小由它控制；细节可通过 `region` 参数按原图坐标全保真回读（`region` 与 `full_resolution` 不受此预算限制） |

`max_edge_px` 可被环境变量 `KIMI_IMAGE_MAX_EDGE_PX` 覆盖，`read_byte_budget` 可被 `KIMI_IMAGE_READ_BYTE_BUDGET` 覆盖，优先级均高于配置文件。

哪些图片格式能送达模型，取决于该请求最终解析到的 provider。所有 provider 都接受 PNG、JPEG、GIF 和 WebP；Kimi provider 额外接受 BMP、HEIC 和 HEIF，因此 iPhone 照片无需先转换。其他图片会被替换为一行文本提示，说明当前 provider 接受的格式。

## `session_title`

`session_title` 选择由谁来写会话标题。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | `string` | 未设置 | 用于生成会话标题的模型别名。未设置（或留空）时仍由托管 `chat_title` 工具生成，其用量包含在订阅内；设置别名后改用该模型，并沿用相同的标题提示词预算 |

自动生成标题默认开启。可在 GUI 中关闭，也可设置 `[experimental]` 下的 `auto_session_title = false`，或使用 `KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE=0`。

## `experimental`

`experimental` 以 flag id 为 key，存放实验功能 flag 的持久化覆盖。每个 flag 的优先级从高到低：对应的 `KIKI_EXPERIMENTAL_<NAME>` 环境变量、本节、`KIKI_EXPERIMENTAL_FLAG` 总开关，最后是 flag 的内置默认值。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `auto_session_title` | `boolean` | `true` | 是否自动生成会话标题；见 [`session_title`](#session-title) |

其他已注册的 flag 也可以按 id 在这里覆盖，但目前 `auto_session_title` 是唯一的用户可见条目。

## `nb_search`

`nb_search` 配置 Kiki 内置的搜索与抓取模块，也就是 `WebSearch` 和 `FetchURL` 工具背后的能力。该模块是 Kiki 的一部分：随产品一起安装，不需要额外的安装步骤；其中的 provider 实例、凭证槽、lane 和默认 fetch chain 都已经内置。

在这些内置默认值之上，你只需提供所选 provider 的凭证（通过其凭证槽中指定的环境变量），并配置一个默认搜索 lane，让 `WebSearch` 在没有显式 lane 参数时也能运行。字段名与合并行为遵循该模块的 canonical 配置 contract，与独立的 nb-search CLI 共用同一份 schema，因此已有的 nb-search 配置文件可以直接沿用。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider_instances` | `table` | 否 | 命名 provider 实例，包含 `provider_id`、`enabled`、可选的 `credential_slot_id` / `base_url`，以及 provider 专属 `options` |
| `credential_slots` | `table` | 否 | 命名凭据槽，只包含 `provider_id` 和 `env` 中的环境变量名 |
| `lanes` | `table` | 否 | 命名 operation lane，包含 `provider_instance_id`、`operation_id`、`latency`、`cost` 和可选 `evidence_groups` |
| `defaults.search_lane` | `string` | 否 | `WebSearch` 使用的默认 lane；未配置时网页搜索 fail-closed |
| `defaults.fetch_chain` | `array<table>` | 否 | 按输入类型和 representation 配置 fetch pipeline chain；URL 的内置默认值为 `direct.fetch`，随后尝试 `jina.reader` |
| `execution` | `table` | 否 | provider 调用数、并发、重试、超时、内联输出、响应大小、重定向、内容长度和质量预算 |

凭据值不会写入 `config.toml`。这是对[供应商凭证](#providers)设计的一次刻意例外——供应商的 `api_key` 写在配置文件里，而搜索模块的凭据放在服务器进程环境中：凭证槽的 `env` 字段只登记环境变量名，凭据值本身从不进入 `config.toml`。Kiki 服务器进程中的环境变量优先，包括显式设置的空值。开启本机复用后，Kiki 可以从服务器 `NB_SEARCH_HOME`（默认 `~/.nb-search`）下的本机 nb-search `secrets.json` 补充缺少的变量，只导入匹配凭证槽的变量，并在使用前校验提供商、地址、凭证槽及文件保护。会重定向已导入凭证的配置变更将被拒绝，不会静默重新绑定。该模块不读取其他终端的变量，也不会自动加载独立的 `.env` 文件。密钥值与凭证文件均不会发送到 GUI。

默认按以下顺序合并设置：该模块的内置默认值、服务器本机的 nb-search 配置、服务器环境变量、Kiki 的 `[nb_search]` 覆盖项。本机文件由 `NB_SEARCH_CONFIG` 指定；未指定时，使用 `NB_SEARCH_HOME`（默认 `~/.nb-search`）下的 `config.json`。默认文件不存在时仍可使用其他配置层；显式路径不存在或文件不可读时，该来源会显示不可用。

在「设置 → 搜索与抓取 → 概览与配置来源」中查看来源并控制复用，也可以设置独立的宿主选项：

```toml
[nb_search_source]
reuse_local_config = false
```

`reuse_local_config` 默认为 `true`。设为 `false` 后会跳过服务器本机的 nb-search 配置与凭证文件——内置模块改用 Kiki 自身的配置与内置默认值继续工作——既不修改被跳过的文件，也不删除 Kiki 已保存的配置或凭证环境变量。隔离模式的默认搜索存储位于 Kiki 缓存目录下，显式设置的 `nb_search.home` 和 `nb_search.jobs_root` 仍优先生效。修改无需重启，下次运行时请求即使用新配置。来源选择保存成功不代表搜索 Lane 已就绪，需要分别查看配置来源与工具的就绪状态。连接远程 Kiki 服务器时，这些文件和环境变量属于服务器，而非浏览器所在机器。

```toml
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "NB_SEARCH_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"

[nb_search.execution]
max_provider_calls = 16
max_concurrency = 4
retry_count = 1
search_timeout_ms = 30000
fetch_timeout_ms = 60000
max_inline_bytes = 65536

[nb_search.execution.fetch]
max_source_bytes = 2097152
max_response_bytes = 2097152
max_content_chars = 200000
max_redirects = 5
```

## `permission`

`permission` 设置会话启动时自动加载的权限规则，控制 Agent 调用工具时是否需要用户确认。规则用 `[[permission.rules]]` 数组表写出，按顺序匹配，第一条命中即生效。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `decision` | `string` | 是 | 匹配后的处置：`allow`（直接放行）、`deny`（直接拒绝）、`ask`（每次询问） |
| `scope` | `string` | 否 | 规则有效范围：`turn-override`、`session-runtime`、`project`、`user`；默认 `user` |
| `pattern` | `string` | 是 | 匹配模式，格式为 `工具名` 或 `工具名(参数模式)`，如 `Read`、`Bash(rm -rf*)` |
| `reason` | `string` | 否 | 规则说明，仅用于调试和审计 |

内置工具名见[内置工具](../reference/tools.md)。大多数支持规则参数的内置工具会定义自己的匹配对象，例如 `Bash(command-pattern)` 或 `Read(path-pattern)`。MCP 工具和自定义工具只能按工具名匹配，不支持参数模式。

```toml
[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "allow"
pattern = "Grep"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash"
```

### 危险 Bash 命令

`permission.dangerous_bash` 是三态开关，控制 tree-sitter Bash 分析器。它识别 `rm -rf`、`shutdown`、向块设备 `dd`，以及 `sudo` / `bash -c` 等包装后的危险命令。开启后，原本会被自动放行的危险命令升级为 `ask`，走既有审批路径；既有 deny 路径不变。无法分析的命令不会升级。

| 取值 | 效果 |
| --- | --- |
| `default`（未设置） | `manual` / `auto` 开启，`yolo` 关闭 |
| `on` | 始终把危险 Bash 升级为 `ask`，包括 `yolo` |
| `off` | 不介入 |

`yolo` 默认关闭，是为了不改写 Never Ask / yolo 的明确承诺。只有你确实要在该模式下也拦危险命令时，才设为 `on`。

```toml
[permission]
dangerous_bash = "default"
```

::: tip
MCP server 的声明配置写在 `~/.kiki/mcp.json` 或项目内 `.kiki/mcp.json` 中，不在 `config.toml` 里。旧的 `.kimi-code/mcp.json` 路径只作为迁移来源；运行 `kiki migrate-config --workspace <目录>` 将其复制到 `.kiki/`。交互式配置入口是内置的 `kiki-ops` Skill（负责 Kiki 产品使用与配置的内置 Skill）：输入 `/kiki-ops 帮我配置 MCP`，详见 [Model Context Protocol](../server/mcp.md)。
:::

## `prompt`

`prompt` 无需复制 Agent profile，即可覆盖具有稳定语义的文案字段。字段值直接替换对应文案单元，不做追加、前置或包裹。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `variables` | `record<string, string>` | `{}` | 覆写字段中以 `${name}` 引用的命名变量。名称必须匹配 `[A-Za-z_][A-Za-z0-9_]*`；内置运行时名称属于保留名，不能在此重定义 |
| `overrides` | `table` | `{}` | 全局 [`PromptOverrides`](#提示词覆写格式)，可包含 `files` 与 `fields` |

常用内置字段 ID 包括 `system.language`、`system.reply_style`、`system.coding`、`system.shared`、`tool.web-search.description`、`tool.web-search.guidance`、`delegation.sub.notice` 和 `delegation.independent.notice`。System 字段替换内置提示词的对应段落；`system.shared` 是唯一的共享外层补充，非空时只追加一次。工具 `description` 替换静态说明，但保留运行时生成的动态细节；非空 `guidance` 会在既有的 `User-configured guidance:` 标签下追加。

`${name}` 只做单遍字面替换，不递归，也不执行脚本。字段可以使用自身声明的内置变量及 `[prompt.variables]` 中的名称；未知名称会被拒绝。`${base_prompt}`、`${parent_prompt}` 等整篇组合变量不能用于字段。

```toml
[prompt.variables]
search_guidance = "除非问题明确要求历史信息，否则优先用最近的结果。"

[prompt.overrides]
files = ["prompt/team.toml"]

[prompt.overrides.fields]
"system.shared" = "引用网络来源时，请给出实际打开页面的 URL。"
"tool.web-search.guidance" = "结果跨多年时遵循 ${search_guidance}。"
```

### 提示词覆写格式

每个覆写表面都使用相同对象：

```text
files?: string[]
fields?: record<string, string>
```

`files` 中的路径相对于 Kiki 主目录（默认为 `~/.kiki`）。绝对路径、`..` 穿越、经符号链接逃逸、缺失文件、非法 TOML、重复 key 与未知字段 ID 都会让校验失败。每个外部文件都是严格 TOML，只能包含 `schema_version = 1` 和一个 `[fields]` 表，不能继续引用其他文件：

```toml
schema_version = 1

[fields]
"system.language" = "除非用户指定其他语言，否则使用用户的语言回复。"
"tool.web-search.description" = "通过 Kiki 已配置的搜索运行时检索公开网页来源。"
```

同一表面内按列表顺序应用文件，内联 `fields` 最后应用。不同表面从低到高依次为全局 `[prompt.overrides]`、模型 `[models."<alias>".prompt_overrides]`、Agent 或 `SYSTEM.md` Frontmatter 的 `prompt_overrides`，以及匹配的 `model_profiles[].prompt_overrides`。缺失 key 继承下层值；空字符串仅能明确清空允许为空的字段。

```toml
[models.fast-model.prompt_overrides]
files = ["prompt/fast-model.toml"]

[models.fast-model.prompt_overrides.fields]
"system.reply_style" = "回答保持紧凑，并以行动为导向。${reply_style_guide}"
```

Agent 与 `SYSTEM.md` Frontmatter 使用等价的 YAML mapping：

```yaml
prompt_overrides:
  files:
    - prompt/reviewer.toml
  fields:
    system.coding: 优先做最小且经过验证的修改。
```

每个 turn 的首个模型请求准备时，会冻结当前 profile、模型、字段注册表、配置和已加载覆写文件。合法的被监听文件更新从下一 turn 生效，绝不会在当前 turn 中途变化。刷新失败时，Kiki 会报告 `prompt-fields-refresh-failed` 并保留上一份有效快照，不会部分应用损坏的更新。

整篇替换的 `SYSTEM.md` 或 Agent 正文，以及模型 cognition 的 `replace` 会遮蔽对应的 `system.*` 字段。Cognition anchor 会逐字发送，因此 anchor 生效时 system 与 delegation 字段处于 inactive 状态；工具字段仍然有效。这些状态只用于诊断，不会插入提示词。

::: warning 移除
旧的 `[prompt] shared` 和 `[prompt.tools]` 键已经移除，继续使用会触发严格配置解析错误。把 `shared` 迁到 `[prompt.overrides.fields]` 下的 `"system.shared"` 键；每个工具条目迁到 `tool.<kebab-case-name>.guidance`（例如 `WebSearch` 对应 `tool.web-search.guidance`）。
:::

桌面 GUI 中，请进入「设置 → 智能体 → 提示词」编辑本节；该卡片默认折叠，展开后再编辑。

## `tui.toml`

除了 `config.toml`，CLI 还在同一目录下用一份配套的 `tui.toml` 保存终端界面与客户端偏好（`~/.kiki/tui.toml`，或覆盖后的 `$KIKI_HOME/tui.toml`）。它在首次运行时以默认值创建，交互式命令 `/config`、`/theme`、`/editor` 会自动写入，通常无需手动编辑。文件格式有误时，CLI 会回退到默认值并给出提示，而不是启动失败。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | 配色主题：`auto`（跟随终端）、`dark`、`light`，或[自定义主题](../customization/themes.md)的名字 |
| `render_latex` | `boolean` | `true` | 将 Markdown 消息中的 LaTeX 公式（`$…$`、`$$…$$`）渲染为 Unicode 文本；`false` 则保留原始源码 |
| `disable_paste_burst` | `boolean` | `false` | 禁用非 bracketed paste 的粘贴突发兜底；默认开启，避免快速多行粘贴被逐行提交 |
| `cache_expiry_hint` | `boolean` | `true` | resume 长时间未活动的会话、或长时间空闲后发送消息时，若上下文缓存可能已过期则弹出提醒，可选择先压缩或新建会话 |
| `[editor].command` | `string` | `""` | 编写长输入用的外部编辑器命令；留空则回退到 `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | 是否发送桌面通知 |
| `[notifications].notification_condition` | `string` | `unfocused` | 何时通知：`unfocused`（仅终端失去焦点时）或 `always`（总是） |
| `[status_line].items` | `string[]` | `[]` | 底部状态栏第一行展示哪些内置槽位及其顺序：`mode`、`goal`、`model`、`tasks`、`cwd`、`git`、`tips`。缺省保持默认布局；未知 id 跳过并告警 |
| `[status_line].command` | `string` | `""` | 自定义状态栏命令。其 stdout 第一行替换状态栏第一行，stdin 会收到 JSON 快照（model、cwd、git 分支、permission 模式、plan 模式、上下文用量、session id、版本）。运行上限 300ms、每秒最多一次；失败时回退内置布局 |

```toml
# ~/.kiki/tui.toml
theme = "auto" # "auto" | "dark" | "light" | 自定义主题名
render_latex = true # false 表示消息中的 LaTeX 公式保留原始源码
disable_paste_burst = false # true 表示禁用非 bracketed paste 的粘贴突发兜底
cache_expiry_hint = true # false 表示关闭 resume / 空闲提交时的"缓存已过期"提醒弹窗

[editor]
command = "" # 留空则使用 $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

# [status_line]
# items = ["mode", "goal", "model", "tasks", "cwd", "git", "tips"]
# command = "~/.kiki/statusline.sh"
```

修改在下次启动时生效，或用 `/reload-tui` 立即生效（只重载 `tui.toml`）；`/reload` 会同时重载 `config.toml` 和 `tui.toml`。

## 项目级本地配置

除了 `~/.kiki` 下的用户级文件，Kiki 还会读取位于 `<项目根目录>/.kiki/local.toml` 的项目级本地配置文件。它保存的是与某一个项目检出相关、通常不应与队友共享的设置。旧的 `.kimi-code/local.toml` 路径不会自动加载；运行 `kiki migrate-config --workspace <目录>` 将其复制到 `.kiki/`。

该文件会在你通过 [`/add-dir`](../reference/slash-commands.md) 添加额外工作目录并选择记入项目时自动创建，通常无需手动编辑。

### `[workspace]`

`[workspace]` 表用于存放项目级的工作区设置：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | 否 | 额外工作目录列表，以绝对路径存储。在 `/add-dir` 中确认"记住此目录"时自动写入；启动时读回，使这些目录在该项目的每个会话中都可用 |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

目录以绝对路径存储，与具体机器相关。因此建议把 `.kiki/local.toml` 加入项目的 `.gitignore`，避免被提交。

## 下一步

- [平台与模型](./providers.md) — 各供应商类型（Kimi、Claude、OpenAI、Gemini）的接入示例
- [配置覆盖](./overrides.md) — CLI 选项、配置文件、环境变量的优先级规则
- [环境变量](./env-vars.md) — `KIKI_HOME` 等运行时变量的完整列表
