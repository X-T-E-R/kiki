# 配置文件

Kiki 把所有长期偏好写进 `~/.kiki/` 下的 TOML（一种结构清晰的纯文本配置格式）文件——比如使用哪个模型、填哪个 API 密钥、Agent 每轮最多跑几步。保存后会保留到下次启动；`config.toml` 与供应商凭证也会在 Kiki 运行中自动重载。Agent 与运行时设置放在 `config.toml`，供应商凭证放在独立的 `credentials.toml`，终端界面与客户端偏好（主题、编辑器、通知、自动更新）放在配套的 `tui.toml`。

默认位置：`~/.kiki/config.toml`，首次运行时自动创建。供应商凭证放在 `~/.kiki/credentials/credentials.toml`，详见 [供应商凭证](#供应商凭证)。

## 配置文件位置

CLI 从 `~/.kiki/config.toml` 读取配置。如需把数据目录迁移到别处，可用 `KIKI_HOME` 环境变量覆盖：

```sh
export KIKI_HOME=/path/to/kiki-home
```

此时配置文件路径变为 `$KIKI_HOME/config.toml`。无论目录在哪里，文件名固定是 `config.toml`。

覆盖数据目录后，供应商凭证路径为 `$KIKI_HOME/credentials/credentials.toml`。`credentials/` 目录还存放 OAuth 与 MCP 凭据。

::: tip
TOML 字段名一律用下划线（snake_case），如 `default_model`、`max_context_size`。字段名里若含 `.`，需用引号包住，例如 `[models."gpt-4.1"]`——否则 TOML 会把 `.` 解释为嵌套表分隔符。
:::

## 配置修改如何生效

Kiki 会在运行它的主机上监听 `config.toml` 和 `credentials/credentials.toml`。保存合法修改、文件内容稳定后会自动重载；修改请求并发规则不需要重启或执行 `/reload`。定期检查会补上遗漏的文件通知，尚未写完的内容会稍后重试；解析失败时保留上一份有效配置，并给出诊断。请修复诊断中指明的文件，不要从设置页覆盖它。

文件重载与设置生效的时机不同：

| 设置 | 生效时机 |
| --- | --- |
| [`request_governance`](#request-governance) | 修改加载后立即重新判断排队请求；已在途的流正常结束 |
| `default_model`、`default_permission_mode`、`default_plan_mode` 等会话默认值 | 新会话；已有会话保留自己的选择 |
| [`identity`](#identity) | 下次启动进程 |
| [`tui.toml`](#tui-toml) | 下次启动，或在 TUI 执行 `/reload-tui` |

TUI 的 `/reload` 仍可手动重载 `config.toml` 和 `tui.toml`。按轮次或会话保存快照的设置遵循各节说明的时机；文件自动重载不会替换正在执行的请求。

## 完整示例

以下示例覆盖最常用的配置项，可直接复制后按需修改：

```toml
default_model = "kimi-code/k3"
default_permission_mode = "auto"
default_plan_mode = false
merge_all_available_skills = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

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
max_attempts_per_step = 5
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

## 连续性提醒词表

Kiki 会提醒 Agent 记录持续有效的指示、查找早先决定、更新未完成待办，并在上下文压缩前后保留工作笔记。提醒追加到对话历史，不会自动保存记忆或修改系统提示词。进度提醒需要 `TodoList`；`TodoList` 不可用但记忆访问已获批准时，记录指示和回看历史提醒仍可工作。

人类轮次节奏与中英文词表统一在 [`loop_control`](#连续性提醒设置) 下配置。Assistant 消息、工具轮询和转发的 Agent 消息不计为人类轮次。记忆不可用时，提醒不会建议调用 `MemoryWrite`。

## 供应商凭证

供应商凭证——Kiki 调用各供应商时使用的 API 密钥——存放在 `~/.kiki/credentials/credentials.toml`（覆盖数据目录时为 `$KIKI_HOME/credentials/credentials.toml`）。普通配置仍留在 `config.toml`；凭证值保持原来的 TOML 路径，供应商的 `api_key` 只是从 `config.toml` 的 `[providers."<name>"]` 表移到这里的同名表下。

```toml
# ~/.kiki/credentials/credentials.toml
[providers."managed:kimi-code"]
api_key = "YOUR_API_KEY"
```

该文件是可选的。文件不存在时按空处理，回退到 `config.toml` 里仍然存在的凭证；两个文件为同一个供应商凭证都写了值时，`credentials.toml` 中的值优先。

`api_key` 与 `[providers.<name>.env]` 备用来源之间的字段级优先级见[配置覆盖](./overrides.md#供应商凭证)。

### 迁移已有密钥

如果根目录还留有旧版 `credentials.toml`，启动时会把其内容原样迁入 `credentials/credentials.toml`；迁移成功前仍可从旧位置读取。如果新旧两处内容不同，Kiki 会停止而不擅自选择，请核对两份文件后重试。如果旧版 `config.toml` 里仍留有供应商凭证，启动时会把它们迁入 `credentials/credentials.toml`，并重写 `config.toml`（不再包含这些凭证）。原 `config.toml` 会以唯一的 `config.toml.bak-<YYYY-MM-DD>-<uuid>` 名称保留为备份，便于查看或恢复。备份仍含原来的明文密钥；确认迁移成功后，若不再需要备份，请将其删除。成功迁移后重复加载不会另建备份，也不会改动已迁出的凭证。如果两个文件的同一密钥路径有不同的值，迁移会停止并要求人工核对，不会擅自选择其一；失败或中断的迁移也可能留下需检查的备份。

### 文件权限

在 POSIX 系统上，Kiki 创建和改写 `credentials.toml` 时会请求仅属主可读写的权限（`0600`）。在 Windows 上，实际访问权限取决于文件及其父目录的 ACL；Kiki 目前不会验证或修复通用 `credentials.toml` 的 ACL。若要防止其他本机用户读取，请自行核查这些权限。

### 密钥处理

供应商读取 API 会返回本地存储的 API 密钥，供你在 GUI 中查看和编辑；使用环境变量的凭证只暴露变量名，不返回变量值。因此，能访问服务端 API 的人也可能读取这些已存密钥。请妥善保护 `credentials.toml` 和迁移备份。

## 顶层字段

配置文件里的字段分两类：**顶层标量**直接控制默认行为，**嵌套表**（`providers`、`models`、`thinking` 等）各有独立结构，在下文各节单独说明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_model` | `string` | — | 默认模型别名，必须在 `models` 中定义 |
| `default_permission_mode` | `string` | `auto` | 新会话默认权限模式：`manual` 询问未经批准的操作；`auto` 自动批准普通操作、询问受保护操作；`review` 先交给审查者；`yolo` 批准大部分工具操作，但 Git 控制路径仍可能询问 |
| `default_plan_mode` | `boolean` | `false` | 新会话是否默认以 Plan 模式（先出计划再执行）启动 |
| `merge_all_available_skills` | `boolean` | `true` | 是否合并所有目录中的 Agent Skills |
| `extra_skill_dirs` | `array<string>` | — | 额外 Skill 搜索目录，叠加到默认目录之上 |
| `extra_agent_dirs` | `array<string>` | — | 额外自定义 Agent 搜索目录，叠加到默认目录之上 |
| `skip_builtin_profile_installation` | `array<string>` | — | 启动时不安装到 `agents/builtin/` 的内置模板名称。已有受管理副本仍可使用并继续接收安全更新；它不是运行时禁用开关 |
| `disabled_named_profiles` | `array<string>` | `[]` | 从 subagent 发现与派发列表中隐藏的 profile 名称，不区分文件来源。默认 main `agent` 绑定仍可使用 |
| `builtin_product_skills` | `boolean` | `true` | 是否向模型提供 Kiki 产品 Skills：`kiki-ops` 负责产品使用与配置，`kiki-profile` 负责创建和修改 agent profile。关闭后两者的名称和描述都不再进入系统提示词，代价是失去这些任务的引导流程 |
| `providers` | `table` | `{}` | API 供应商表 → [`providers`](#providers) |
| `models` | `table` | — | 模型别名表 → [`models`](#models) |
| `thinking` | `table` | — | Thinking 模式默认参数 → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent 循环控制参数 → [`loop_control`](#loop-control) |
| `retry` | `table` | — | 按错误定制的单步重试策略 → [`retry`](#retry) |
| `request_governance` | `table` | 无规则 | 原生模型请求并发与等待预算 → [`request_governance`](#request-governance) |
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
| `permission` | `table` | — | 权限规则与审查者 → [`permission`](#permission) |
| `interaction` | `table` | — | Agent 提问是否阻塞当前轮 → [`interaction`](#interaction) |
| `hooks` | `array<table>` | — | 生命周期 hook，详见 [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | 自定义 Agent 身份 → [`identity`](#identity) |
| `prompt` | `table` | `{}` | 提示词字段覆写与自定义变量 → [`prompt`](#prompt) |

以下各节对 `providers`、`models`、`thinking`、`loop_control`、`retry`、`token_counting`、`background`、`subagent`、`agents`、`thread_communication`、`mcp`、`tools`、`image`、`session_title`、`experimental`、`nb_search`、`permission`、`interaction`、`prompt` 等嵌套表逐一展开。

## `providers`

`providers` 表的每一项定义一个 API 供应商，以唯一名称为 key。供应商的 `api_key` 放在 [`credentials.toml`](#供应商凭证)，CLI **不会**从 shell 环境变量自动取后备值——在终端里 `export KIMI_API_KEY` 不会让供应商自动获得密钥，请写在 `credentials.toml` 里。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型：`kimi`、`anthropic`、`openai`、`openai_responses`、`google-genai`、`vertexai` |
| `api_key` | `string` | 否 | API 密钥。存放在 `credentials.toml`；仅当 `credentials.toml` 中没有该供应商的值时，才使用 `config.toml` 里的值 |
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
| `pricing_model` | `string` | 否 | 用于估算用量成本的规范模型名，与上游模型 ID 独立；例如代理别名可以按 `gpt-6-sol` 计价。价格缺失时仍标为未知，不会改变实际发给供应商的模型 |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数），必须 ≥ 1 |
| `max_input_size` | `integer` | 否 | 模型声明的单次请求输入上限（当低于总窗口时，如 gpt-5 的 400k 窗口 / 272k 输入）。压缩、上下文溢出检查和用量比率优先使用它；补全预算仍使用总窗口。解析时会被钳制到不超过 `max_context_size` |
| `max_output_size` | `integer` | 否 | 单次请求的输出 token 上限（对应 `max_tokens`）。目前仅 `anthropic` 供应商读取。为 Claude 模型设置后，这个显式值会覆盖内置的服务端最大值 |
| `capabilities` | `array<string>` | 否 | 显式追加的能力标签：`thinking`、`always_thinking`、`image_in`、`video_in`、`audio_in`、`tool_use`。与供应商自动识别的能力取并集，只能追加不能移除 |
| `support_efforts` | `array<string>` | 否 | 模型接受的 Thinking 档位。对 `kimi` 而言，在运行时选择列表外的值会报错；模型解析时若配置值或之前的值不受目标模型支持，会回落到目标模型的 `default_effort`，并将该有效值同步给 UI。支持 Thinking 但没有此字段的 Kimi 模型使用布尔 `on` / `off`。其他 provider 在协议提供原生 effort 字段时会原样传递具体值；协议仅提供等级或 token budget 时，只做必要的格式转换。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] support_efforts` |
| `default_effort` | `string` | 否 | 模型的默认 Thinking 档位。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] default_effort` |
| `service_tier` | `string` | 否 | 使用此模型的每个请求采用的服务档位：`auto`、`default`、`flex` 或 `priority`。优先于 profile、route 和单次请求的档位，对主 Agent 和子 Agent 均生效。只有 `openai_responses` 会编码此字段，其他协议忽略它；省略时保留 profile 或单次请求的档位 |
| `request_params` | `table` | 否 | 合并进该模型每次请求的额外请求参数（如 `temperature`、`top_p`）；取值可为字符串、数字或布尔值。跨层时按键合并 |
| `context_budget` | `integer` | 否 | 该模型有效上下文窗口的 token 上限；不会超过模型真实容量。跨层取最小值 |
| `auto_compact` | `integer` | 否 | 该模型的自动压缩点，写绝对 token 数。profile 或会话层的值优先；不改变模型窗口上限。该字段也可写在本模型的 `overrides` 表中 |
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

### 显式迁移旧版模型参数

打开**设置 → 模型与提供商 → 可用模型 → 旧版模型参数迁移**，点击**预览迁移**可只读检查拟复制的字段，不会写文件。预览仅列模型别名、参数名、需人工核对的原因、修订标识及备份标识；不返回配置原文、凭据值或备份内容。模型参数不会在启动时自动迁移。在没有歧义的情况下，迁移会把旧版 `request_params.temperature`／`top_p` 和 `max_completion_tokens`／`service_tier` 复制进模型的 `parameters` 表。歧义值及冲突项留待人工处理；**旧字段不会被删除**，请先核对预览，不要假定旧字段的行为已经改变。

点击**应用预览的改动**并再次确认后，服务器先在 `config.toml` 旁以唯一的 `config.toml.generation-backup-<uuid>` 名称逐字备份原文件，再有条件地写入新配置。如果配置已变化或预览过期，则拒绝写入，不覆盖新修改。备份可能包含原始密钥，请像保护 `config.toml` 和 `credentials.toml` 一样保护它；服务器配置存储在支持的平台上要求仅文件所有者可读写，但不要假定各平台权限完全相同。面板列出备份标识；**恢复备份**还需单独确认，且只有当前配置仍逐字匹配该备份对应的迁移结果、预览修订仍有效时才会恢复。之后的修改只在配置字节不同的情况下阻止恢复；目前仅凭配置字节计算的修订标识无法发现配置最终回到完全相同字节的修改序列，此时旧备份仍可能撤销一次更新的同内容迁移。在发生后续修改后，不要使用旧备份恢复。备份和配置是两个文件，并非一次跨文件的崩溃原子事务。配置 CAS 明确拒绝过期修订时，只有新备份仍匹配原始字节才会删除；写入结果无法确认时，系统会保留备份和当前配置供核对，而不会冒险回滚另一写者的改动。在 Windows 上，底层原子写会先尝试通过重命名覆盖；若遭遇 `EPERM` 竞争，可能退回先删除目标文件再重命名，读者会短暂看不到配置，且在该空窗崩溃可能导致目标缺失。遇到不确定的失败，请先检查两个文件及备份再重试。

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

`[models."<alias>".overrides]` 接受普通模型字段，例如 `max_context_size`、`max_input_size`、`max_output_size`、`capabilities`、`display_name`、`reasoning_key`、`adaptive_thinking`、`support_efforts`、`default_effort`、`off_effort`、`service_tier`、`request_params`、`context_budget`、`auto_compact` 与 `max_completion_tokens`。不接受身份 / 路由字段：`provider`、`model`、`protocol`、`beta_api` 和 `base_url`。对这些新增字段，先得到模型 alias 的有效配置（包括其 `overrides`），再按 "模型 alias → profile 顶层 → 命中的 `model_profiles` 条目" 合并：`request_params` 逐键覆盖，`service_tier` 使用最后一个明确值；`context_budget` 和 `max_completion_tokens` 是限制，取各层声明值的最小值，并继续受模型容量与输出上限约束。省略限制表示不增加限制。

无需修改配置文件也可以临时切换模型——通过 `KIKI_MODEL_*` 环境变量在内存里合成一个临时供应商，详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kiki-model)。

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

子 Agent 按此顺序选模型：具体的 `AgentRun` 参数 `model_alias` → 生效 profile、route、caller lease 上的 pin → 显式配置的 `[subagent].default_model`。
调用方模型与主 Agent 的 `default_model` 都不是静默回退来源；这些来源都不存在时，派发会以 `model.not_configured` 失败，不会创建子 Agent。在 subagent profile、route 或 caller lease 中写 `model_alias: inherit`，才会绑定调用方当前已解析的模型。`AgentRun` 拒绝 `model_alias: "inherit"`：请写具体的已配置模型名，或省略参数以使用目标默认模型。main agent 没有调用方，其 profile 不可使用 `inherit`。

thinking effort 可以留空。使用 `model_alias: inherit` 时，它会跟随调用方的有效思考强度；工具显式 `effort`，或 profile、route、caller lease、匹配的 `model_profiles` 条目上适用的 effort pin 优先。其他情况下按工具 `effort` → 匹配的 `model_profiles` 档位 → 所选模型与 profile pin 匹配时的 `thinking_effort` → 所绑定模型的 `overrides.default_effort` → 模型的 `default_effort` → 全局 [`[thinking].effort`](#thinking) → 模型能力兜底档位解析。

## `thinking`

`thinking` 设置 Thinking 模式的全局默认行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 新会话是否默认开启 Thinking；设为 `false` 时，未固定的 effort 会关闭，但显式请求与模型覆盖项仍生效 |
| `effort` | `string` | — | 模型的 `default_effort` 和 `overrides.default_effort` 之后的全局兜底档位（例如 `low`、`medium`、`high`、`xhigh`、`max`）。非 Kimi provider 在上游协议接受具体 effort 值时不会改写该值；如果上游拒绝，请改成该模型支持的档位。协议仅提供等级或 token budget 时，仍需做格式转换。对于带 `support_efforts` 的 Kimi 模型，若该配置值不在列表中，会回落到模型默认档位；没有该列表的 Kimi 模型会把任意开启值视为布尔 `on` |
| `keep` | `string` | `"all"` | 保留思考透传。在 `kimi` 上以 `thinking.keep` 发送；在 `anthropic`（Claude 以及 Kimi 的 Anthropic 兼容模式）上以 `context_management` 的 `clear_thinking_20251015` 编辑发送（开启 keep 会让 Anthropic 请求走 beta Messages API；关值可禁用 keep 并回到标准端点）。`"all"` 会保留历史轮次的思考内容（`reasoning_content` / Anthropic thinking blocks）；传入关值（`false`/`0`/`no`/`off`/`none`/`null`）可禁用。可被 `KIKI_MODEL_THINKING_KEEP` 覆盖；仅在 Thinking 开启时注入 |

### 已废弃字段

| 字段 | 废弃版本 | 描述 |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | 顶层布尔值，由 `[thinking] enabled` 取代。将 `default_thinking = true` 迁移为 `enabled = true`，`default_thinking = false` 迁移为 `enabled = false`。 |
| `thinking.mode` | 0.21.0 | 可选值 `auto` / `on` / `off`，由 `[thinking] enabled` 取代。`mode = "off"` 改为 `enabled = false`；`mode = "on"` 和 `mode = "auto"` 等价于 `enabled = true`（默认值），可删除该行。 |

## `loop_control`

`loop_control` 控制 Agent 执行循环的步数上限、单步尝试次数上限、触发上下文自动压缩的阈值，以及压缩请求失败后的尝试次数上限。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | 单轮最大步数；不设或设为 `0` 则无上限 |
| `max_attempts_per_step` | `integer` | `5` | 单步失败后的最大总尝试次数（含首次尝试） |
| `reserved_context_size` | `integer` | `50000` | 自动压缩点以上为模型输出预留的 token 数 |
| `auto_compact` | `string` | — | 全局默认自动压缩点，按模型可用窗口写百分比，如 `"85%"`。全局不接受 token 数；模型、profile、会话用正整数 token |
| `compaction_trigger_ratio` | `number` | `0.85` | 旧版触发比例，仅在各层都没有设置 `auto_compact` 时使用 |
| `compaction_soft_context_size` | `integer` | `0` | 旧版绝对 token 上限，仅在各层都没有设置 `auto_compact` 时使用 |
| `compaction_max_attempts` | `integer` | `3` | 压缩失败后的最大总请求次数（含首次请求）；所有恢复路径共用这份预算 |

会话按模型保存的 token 覆写优先，其次为命中的 `model_profiles` 条目、profile 顶层、模型别名，最后才是全局百分比。没有任何新 `auto_compact` 时，沿用旧阈值：`min(0.85 × 可用窗口, 可用窗口 − 50000, 正值 compaction_soft_context_size)`；显式旧比例替换 0.85。保存全局新值时，会按当前模型把 token 数换算成百分比，并删除旧比例和绝对 token 上限键；换算后无法保证其他窗口大小不同的模型仍保持旧绝对上限。新阈值在下一个模型 step 前生效，不会立即压缩。用 `/autocompact` 查看当前会话的生效值。

`max_steps_per_turn` 可被环境变量 `KIKI_LOOP_MAX_STEPS_PER_TURN` 覆盖，`max_attempts_per_step` 可被 `KIKI_LOOP_MAX_ATTEMPTS_PER_STEP` 覆盖，优先级均高于配置文件。

重试仅针对瞬时故障——连接错误、超时、HTTP 429 限流，以及所有 HTTP 500–599 服务端错误。账户额度耗尽或余额不足导致的 429 不会重试，会立即失败：在充值之前重试不可能成功。

### 连续性提醒设置

TodoList 和工作笔记的进度提醒按人类轮次计时，不按 Assistant 消息数量计时。已接收的用户提示、用户调用的插件命令和用户通过斜杠激活的 Skill 会推进时钟。人类 steer 纠正可触发记录指示或回看历史提醒，但不增加轮次。转发的 peer 消息、subagent 回执、模型激活的 Skill 和定时触发不推进时钟，也不构成新的人类规则。以下三个节奏字段接受正整数，示例即默认值：

```toml
[loop_control.continuity_cadence]
age_human_turns = 6
cooldown_human_turns = 8
long_task_steps = 24
```

常规进度提醒需要有新的成功工作，距相关内容变更至少六个人类轮次，距该类上次提醒（或会话开始）至少八个人类轮次。该类首次提醒后间隔加倍到 16 个人类轮次；每类状态未变时最多发出两次进度提醒。待办提醒要求仍有未完成项。笔记提醒还要求未覆盖工作量达到 8,000 token 与压缩阈值的 10% 两者中的较大值。长任务笔记检查点可不等待新的人类轮次：距上次笔记变更和上次笔记提醒均须完成至少 24 个成功工作 step，未覆盖工作量还须达到 16,000 token 与压缩阈值的 10% 两者中的较大值。仅轮询不算成功工作。

待办与笔记分别保留年龄、工作水位、提醒时钟和两次提醒预算。内容实际变化只重置该类的年龄、工作水位及提醒预算，提醒间隔回到基础冷却值。修改列表不会重置笔记状态，修改笔记也不会重置列表的。重复写入相同内容不重置这些状态。

若要关闭低频的长期记忆维护提醒，同时保留任务进度提醒，设置：

```toml
[loop_control.continuity_cadence]
memory_maintenance = false
```

`memory_maintenance` 是布尔值，省略时默认为 `true`。合法配置重载后，从下一次提醒判断起生效，不会删除对话中已有的提醒。它只控制活跃工作期间的周期性维护提示（M3），每个上下文窗口最多一次。设为 `false` 后，新的人类持续指示提醒（M1）与压缩前对已识别、仍未处理指示的检查（M2）仍保留。它不会禁用记忆工具、改变审批策略或关闭 TodoList 工作笔记。

记忆提醒仅对非临时会话中的主 Agent 可用，前提是已启用记忆、记忆审批不为 `off`，且 `MemoryWrite` 已注册并获工具策略允许。空闲或只做轮询时不发周期性提醒。提醒要求保留对未来任务有用的指示、稳定决定或有证据的知识；没有值得保留的变化就不写。任务进度留在工作笔记中，待审批的记忆提案不算生效指引，也不应重复创建。

记录指示和回看历史提醒先匹配可配置的中英文词表，再经过本地结构门判断，不单独调用分类模型：

```toml
[loop_control.directive_cues]
instructions = ["always", "never", "以后", "不要"]
history = ["as I said", "earlier", "之前", "我说过"]
```

提供的列表替换默认列表；空列表关闭该类提醒。英文词按单词边界匹配且不区分大小写，中文词按子串匹配。命中关键词还不够：引用示例和产品讨论不能确立持久规则，steer 纠正也必须经过同一结构门。记录指示和回看历史提醒按已接收的输入或 steer 修订去重，不是整个 turn 最多一次。已覆盖的历史引用不重复提醒；对同一已识别主题的重复引用，在待办和笔记状态未变时有三个人类轮次的冷却。新的规则修改和撤销不受该历史冷却或进度冷却限制。

配置决定默认记入任务笔记，除非用户明确要求更广的适用范围；跨会话记忆仍受原有审批策略约束。上下文窗口保留与交接重建提醒跟随压缩状态，不使用进度提醒节奏。

新会话把变化的日期、目录列表、工作区指令和记忆放在带版本的运行时快照消息中，不再为这些变化重写系统提示词。已有会话保留原布局，直到自然上下文压缩边界才迁移；不会重排旧历史。Profile 绑定、配置的提示词和运行时权限仍会随底层策略变化而更新。

## `retry`

`retry` 可为指定的单步错误定制总尝试次数与固定退避时间。默认情况下，可重试的单步最多尝试 5 次，重试前依次等待 2、4、8、16 秒，并加入最多 25% 的随机抖动（总计 30–37.5 秒）。provider 返回的 `Retry-After` 值或命中策略的固定 `backoff` 会替代对应的默认等待时间。本节及每条策略都是严格配置：未知字段会被拒绝，不会静默忽略。

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

`strategy` 可被环境变量 `KIKI_TOKEN_COUNTING_STRATEGY` 覆盖，优先级高于 `config.toml`。

## `background`

`background` 控制后台任务（通过 `Bash` 工具的 `run_in_background=true` 参数，或 `AgentRun` 工具的 `background=true` 参数启动）的并发数。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `false` | 会话关闭时是否保留仍在运行的后台任务。默认情况下，Kiki 会在进程退出前请求停止所有后台任务；只有希望任务在会话结束后继续运行时才设为 `true`。在 print 模式（`kiki -p`）下，本字段仅作为 `print_background_mode` 未设置时的兼容回退：`true` 等价于 `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | 会话关闭、手动停止或任务超时请求正常终止后，等待任务自行结束的宽限时间（毫秒）。超过该时间仍在运行时，Kiki 会尝试强制停止该任务 |
| `bash_auto_background_on_timeout` | `boolean` | `true` | 前台 `Bash` 命令触及超时时间时，将其转为后台任务而不是直接终止：命令完成时 agent 会收到通知，转入后台的命令受 `bash_task_timeout_s` 默认后台超时约束。设为 `false` 则恢复超时即终止的行为 |
| `bash_file_tool_hints` | `boolean` | `true` | `Bash` 命令只用于读、搜、写文本文件时，在结果末尾附一行专用工具提示。命令仍照常执行；设为 `false` 可关闭提示 |
| `bash_task_timeout_s` | `integer` | `600` | 后台 `Bash` 任务在调用未传 `timeout` 时的默认超时（秒）；前台命令超时转后台后也按此值重新计时。`0` 表示无超时——任务一直运行到自行结束或被模型手动停止。显式传入的 `timeout` 不受影响。在 print 模式（`kiki -p`）下未显式设置时默认为 `0` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | 仅 print 模式（`kiki -p`）生效，决定 main agent 的 turn 结束后如何处理未返回的后台任务：`"exit"` 立即退出；`"drain"` 退出前等待所有后台任务进入终态（结果不回馈给 main agent）；`"steer"` 不退出，让后台任务完成时像后台 subagent 一样以合成 user 消息 steer main agent 进入新 turn，直到某 turn 结束时无未决后台任务或触及上限。设置后优先级高于 `keep_alive_on_exit` 的 print 回退 |
| `print_wait_ceiling_s` | `integer` | `2147483` | print 模式（`kiki -p`）下，`print_background_mode` 为 `"drain"` 或 `"steer"` 时，等待/steer 循环的墙钟上限（秒；默认约 24.8 天，近似不设限）。在非 print 模式或 `"exit"` 时无效 |
| `print_max_turns` | `integer` | `100000` | print 模式（`kiki -p`）且 `print_background_mode = "steer"` 时，允许由后台任务完成触发的新 turn 的最大数量，防止 steer 循环失控（默认值近似不设限） |

`keep_alive_on_exit` 可被环境变量 `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖，`max_running_tasks` 可被 `KIKI_BACKGROUND_MAX_RUNNING_TASKS` 覆盖，优先级均高于配置文件。

在 print 模式（`kiki -p "<prompt>"`）下，只要还有未决的后台任务，Kiki 在 main agent 的 turn 结束后不会退出：每个任务完成都会以合成 user 消息回馈给 main agent，steer 出新的 turn（默认 `print_background_mode = "steer"`），直到某 turn 结束时没有任何未决任务才退出。该循环受 `print_wait_ceiling_s` 与 `print_max_turns` 约束，默认值都近似不设限。print 模式下后台工作也不会被墙钟超时杀掉：后台 `Bash` 任务默认无超时（`bash_task_timeout_s = 0`），subagent 默认无超时（`[subagent] timeout_ms = 0`），只有模型自己能停止任务。将 `print_background_mode` 设为 `"drain"` 可等待任务结束但不回馈结果，设为 `"exit"` 则在 main agent 结束后立即退出。

## `subagent`

`subagent` 控制派生 subagent（`AgentRun`）的运行方式。角色选择使用 profile 的 [`can_spawn_subagents`、`allowed_subagents`、`preferred_subagents` 和 `deny_subagents`](../customization/agents.md#agent-文件格式)；原宿主派发策略设置已移除。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_profile` | `string` | 内建通用提示词 | `AgentRun` 省略 `profile`、`route` 和 `profile_file` 时采用的显式 profile 覆盖。该键不存在时（包括只配置了部分字段的 `[subagent]` 表），`AgentRun` 使用内建通用 subagent 提示词，不加载目录中的 profile。设为 `""` 要求显式指定目标（严格模式） |
| `default_model` | `string` | — | 仅在派发参数与生效 profile、route、caller lease pin 都未选模型时使用的显式兜底；从不继承调用方 |
| `deny_models` | `string[]` | — | alias 解析后应用于所有子 Agent 绑定的硬禁止列表；pin、人工切换、恢复与 advisory 派遣都不能绕过。Profile / lease / 树策略 / model-profile 硬规则仍是额外边界 |
| `allowed_tools` | `string[]` | `[]` | 允许越过原生 subagent 默认限制的精确工具名，适用于 subagent 默认拿不到的全部工具（`BoardRead`、`BoardWrite`、`AskUserQuestion`、`Cron`、`EnterPlanMode` / `ExitPlanMode`、`ThreadCreate` / `ThreadList` / `ThreadRead` / `ThreadWait`）；不会覆盖 profile 白名单、黑名单或其他策略限制 |
| `max_direct_children` | `integer` | `16` | 每个派遣者同时在途的直属子 Agent 执行数上限，包括启动中和取消中；`0` 表示不限 |
| `max_total_subagents` | `integer` | `0` | 单棵会话树同时在途的子 Agent 执行总数上限，包括孙代及更深后代，不含 main；`0` 表示不限 |
| `timeout_ms` | `integer` | `7200000`（2 小时） | 单个 subagent（`AgentRun`）允许运行的最长时间（毫秒）。超时后 subagent 以 `timed_out` 收尾。`0` 表示无超时——subagent 一直运行到自行结束或被模型手动停止。该值是后台任务管理器对每个 subagent 任务的 per-task timeout，因此对前台与后台 subagent 同时生效。在 print 模式（`kiki -p`）下未显式设置时默认为 `0`。注意：超过 `2147483647`（约 24.8 天）的值会被运行时钳到约 24.8 天 |

原生 subagent 默认可以使用普通工具，包括只读的 `MemorySearch` 和 `MemoryRead`。有一批工具默认关闭，需要显式开放：`BoardRead`、`BoardWrite`、`AskUserQuestion`、`Cron`、`EnterPlanMode` 与 `ExitPlanMode`，以及 `ThreadCreate`、`ThreadList`、`ThreadRead` 和 `ThreadWait`。可以按档案在 subagent profile 的 [`tools`](../customization/agents.md#agent-文件格式) 列表中点名，也可以设置服务端默认值：

```toml
[subagent]
allowed_tools = ["BoardRead", "ThreadRead"]
```

省略 `tools` 或只写 `*` 不算显式开放：只有具体工具名才算，通配符本身不会顺带开启任何 opt-in。这两处开放彼此是「或」的关系，但 profile 自己的名单仍会过滤结果：子智能体能用这类工具，只要服务端名单点名了它，**或者**该 subagent profile 的 `tools` 名单点名了它，同时该 profile 还得选中这个工具。因此写了有限 `tools` 名单的 profile 会挡住它没列出的工具，即使服务端开放了这一项；而没写名单（或写了 `*`）的 profile，则对两处开放覆盖到的工具都是开放的。`allowed_tools = []` 会清除服务端额外允许，但不会移除 profile 的显式条目。profile 白名单、`disallowedTools`、禁用工具组、调用方限制、全局与会话策略、功能开关、Plan 模式和调用审批仍然生效；profile 自己的 `disallowedTools` 也能禁用这两处开放过的工具。`MemoryWrite`、`ThreadSend`、`SendMessage` 和 Goal 工具仍仅供 main agent 使用，不能通过这两个入口开放。`Cron` 安排的是当前会话的调度并唤醒 main agent，并不是子 Agent 私有的定时器。MCP 工具、继承的用户工具及其他扩展保持原有默认行为；外部执行器自行管理工具。

这些 opt-in 决定的是 subagent 能用什么；主对话不受它们的限制。主对话能选哪些工具，仍由同一档案自己的 `tools` 与 `disallowedTools` 名单决定。

profile 描述和设置页中的工具列表是配置预览，不保证运行时可用。功能开关、子 Agent 运行环境和审批仍可能阻止调用。

`timeout_ms` 可被环境变量 `KIKI_SUBAGENT_TIMEOUT_MS` 覆盖，优先级高于配置文件。`allowed_tools`、`deny_models` 和两个并发限额没有对应的环境变量。

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

自定义 Agent 的身份标识。默认情况下，上游请求使用 `kiki-cli` 产品名，且不会声明自定义名称或 slug。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | — | Agent 在系统提示词中的自称（填充 `${product_name}` 变量，你自己的 `SYSTEM.md` 和 agent 文件同样适用） |
| `slug` | `string` | 由 `name` 派生 | 协议字段中使用的机器标识：发给第三方 provider 的 `User-Agent` 产品名，以及连接 MCP 服务器时声明的客户端名。省略时由 `name` 派生：转小写，连续的非字母数字字符折叠为 `-` |
| `advertise_as_kimi_code` | `boolean` | `false` | 为兼容 Kimi Code，将发往上游的 `User-Agent` 产品名设为 `kimi-code-cli`，并在上游 HTTP 请求中覆盖 `slug`。默认情况下，Kiki 使用 `kiki-cli` 标识自己 |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"              # 可选
advertise_as_kimi_code = false
```

`name` 和 `slug` 可以通过 `KIKI_IDENTITY_NAME` 和 `KIKI_IDENTITY_SLUG` 环境变量设置，优先级高于 `config.toml`，且不会被写回配置文件——适合不便写配置文件的容器和 CI 场景。

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

`max_edge_px` 可被环境变量 `KIKI_IMAGE_MAX_EDGE_PX` 覆盖，`read_byte_budget` 可被 `KIKI_IMAGE_READ_BYTE_BUDGET` 覆盖，优先级均高于配置文件。

哪些图片格式能送达模型，取决于该请求最终解析到的 provider。所有 provider 都接受 PNG、JPEG、GIF 和 WebP；Kimi provider 额外接受 BMP、HEIC 和 HEIF，因此 iPhone 照片无需先转换。其他图片会被替换为一行文本提示，说明当前 provider 接受的格式。

## `session_title`

`session_title` 选择由谁来写会话标题。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | `string` | 未设置 | 用于写会话标题的模型别名。未设置（或留空）时 Kiki 完全不发标题请求：既不回退到 `fast_model`，也不使用托管的 `chat_title` 工具，因此标题生成不消耗任何订阅用量 |
| `triggers` | `array<string>` | `["first_turn_completed"]` | Kiki 主动写标题的时刻，取值为 `first_user_message`、`first_turn_completed`、`context_compacted` 中的一项或多项。空数组表示关闭自动生成；按需生成标题仍然可用，且仍需配置 `model` |

选定的模型按原有的标题提示词预算直接使用。自动生成不会覆盖你手写的标题，普通按需生成请求也不会。只有强制请求（force）才会替换你手写的标题。

按需生成对应 `POST /api/sessions/{session_id}/title/generate`，SDK 暴露了这个调用。它同样需要 `model`，没有模型就无从发问；其中 `force` 选项才是替换手写标题的那一个，不传则保留你写的标题。

自动生成标题默认开启。可在 GUI 中关闭，也可设置 `[experimental]` 下的 `auto_session_title = false`，或使用 `KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE=0`。没有配置 `model` 时 Kiki 完全不发标题请求，既不会触发任何时刻，也不消耗订阅用量；你手写的标题、以及会话未命名时显示的首行都不受影响。

## `experimental`

`experimental` 以 flag id 为 key，存放实验功能 flag 的持久化覆盖。每个 flag 的优先级从高到低：对应的 `KIKI_EXPERIMENTAL_<NAME>` 环境变量、本节、`KIKI_EXPERIMENTAL_FLAG` 总开关，最后是 flag 的内置默认值。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `auto_session_title` | `boolean` | `true` | 是否自动生成会话标题；见 [`session_title`](#session-title) |
| `native_browser` | `boolean` | `false` | 经由受管浏览器后端运行已保存的浏览器连接；未开启时连接会被拒绝，Agent 也拿不到[浏览器工具](../reference/tools.md#浏览器类) |
| `usage_export` | `boolean` | `false` | 把不含内容的用量批次发送到「用量 → 外部同步」中配置的目的地；关闭时这些路由根本不注册 |

任何已注册的 flag 都可以按 id 用布尔值在这里覆盖。带有自己控件的 flag 在对应功能页开关；没有的会出现在 **Settings → 开发者 → 实验性**，该页按 id 列出服务器上报的 flag。

## `browser_control`

`browser_control` 存放由[浏览器控制](../guides/settings.md#浏览器控制)管理的浏览器连接，以及新会话默认项。设置页是受支持的编辑入口：它按连接保存条目、保存后读回结果再显示，且保存从不启动浏览器。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default_browser` | `string` | 之后创建的会话使用的连接 id；未设置时调用必须自己指定连接 |
| `connections` | `table` | 每条连接一个条目，以连接的固定 id 为 key |

每个条目通过 `type`（`agent-browser-profile` 或 `agent-browser-cdp`）、`name`、`enabled` 以及该接法所需字段描述一条连接；每种接法的字段见设置页。字段与接法不符的条目会被拒绝，已保存的文件保持不变。存入的 CDP 地址按凭据对待：页面显示掩码，只有显式请求时才读取明文。

## `nb_search`

`nb_search` 配置 Kiki 内置的搜索与抓取模块，也就是 `WebSearch` 和 `FetchURL` 工具背后的能力。该模块是 Kiki 的一部分：随产品一起安装，不需要额外的安装步骤；其中的 provider 实例、凭证槽、lane 和默认 fetch chain 都已经内置。

默认的 `WebSearch` lane 是 `github.repositories`，不需要凭证或配置，但只检索 GitHub 仓库。查阅代码库文档时可显式选择 `context7.docs`；它返回 typed 文档上下文，不能与结果型 lane 组合。`duckduckgo.search` 是可选的免密钥通用网页 lane，但其公共 HTML 端点可能返回 CAPTCHA；如需更稳定的通用检索，请配置其他 provider 的凭证并覆盖 `defaults.search_lane`。字段名与合并行为遵循该模块的规范配置约定，与独立的 nb-search CLI 共用同一份 schema，因此已有的 nb-search 配置文件可以直接沿用。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider_instances` | `table` | 否 | 命名 provider 实例，包含 `provider_id`、`enabled`、可选的 `credential_slot_id` / `base_url`、`key_strategy`（`round-robin` 或 `priority`）、`balance_ttl_ms`（60,000–86,400,000 毫秒）及 provider 专属 `options` |
| `credential_slots` | `table` | 否 | 命名凭据槽，只包含 `provider_id` 和 `env` 中的环境变量名 |
| `lanes` | `table` | 否 | 命名 operation lane，包含 `provider_instance_id`、`operation_id`、`latency`、`cost` 和可选 `evidence_groups` |
| `defaults.search_lane` | `string` | 否 | 内置默认值为 `github.repositories`（仅仓库）；通用网页检索需要覆盖。显式删除默认值且不指定 lane 时，`WebSearch` 仍会拒绝运行 |
| `defaults.fetch_chain` | `array<table>` | 否 | URL 默认先用 `direct.fetch`，失败时尝试免密钥的 `jina.reader`；直连成功但内容无用时，需显式配置 `execution.fetch.quality` 规则才能触发回退 |
| `execution` | `table` | 否 | provider 调用数、并发、重试、超时、内联输出、响应大小、重定向、内容长度和质量预算 |

凭据值不会写入 `config.toml`；规范凭据槽仍只有 `provider_id` 与环境变量名 `env`。Kiki 服务器进程环境变量优先，包括显式设置的空值。启用本机复用后，Kiki 会从服务器 `NB_SEARCH_HOME`（默认 `~/.nb-search`）下的 nb-search `secrets.json` 补充缺少的变量，仅导入匹配的凭据槽并校验绑定；重定向会被拒绝。如果这两种来源都没有提供值，可选择使用该凭据槽的 **Kiki 管理凭据**。在「设置 → 搜索与抓取 → 提供商」可保存、显式查看已存值、编辑、覆写或清除。凭据保存在当前 Kiki 服务器主目录下受保护的 `secrets/nb-search/gui-credentials.json`，而非 `config.toml`、nb-search CLI 文件或浏览器存储。修改凭据槽的提供商、变量名、使用该槽的实例或端点会使已存绑定失效，不会静默改绑；核对新绑定后显式覆写或清除旧值。只有 Kiki 管理的值可被查看；服务器环境变量及 CLI `secrets.json` 只显示来源，其值不会发送到 GUI。被引用的不同凭据槽必须使用不同的环境变量名，避免托管凭据跨提供商混用。如果另一处在凭据编辑器打开期间修改了槽的变量名、提供商、使用实例或端点，旧草稿保存时会提示冲突：请重新加载、核对目标后再保存。读写 REST 接口沿用现有 Kiki bearer token；持有它的人可显式查看 Kiki 管理的密钥。远程连接时凭据位于远程服务器；切换连接不会转移编辑器内的值。该模块不会读取其他终端的变量，也不会自动加载 `.env` 文件。

开启本机复用时，`~/.nb-search/secrets.json` 中 `values.NB_SEARCH_TAVILY_API_KEY` 原有的单个 Tavily 密钥可以直接沿用，无须迁移或补充第二个密钥。需要多个密钥时，把同一字段或 Kiki 服务器的 `NB_SEARCH_TAVILY_API_KEY` 环境变量设为有序、逗号分隔的 1–32 个不同且非空的密钥，例如 `YOUR_FIRST_API_KEY,YOUR_SECOND_API_KEY`；逗号两侧的空格会被忽略。不要把密钥写入 `config.toml`，且服务器环境变量仍优先于本机凭证文件。其他已配置凭证槽也使用相同格式。

同一 Kiki 服务器进程中的同步 `WebSearch` 和 `FetchURL` 调用（包括不同会话）共用密钥调度状态；配置或凭证变化时会重新建立调度器。`round-robin` 是默认策略，`priority` 则按顺序优先选用第一个可用密钥。401/403 会在当前 runtime 生命周期内隔离该密钥；429 按 `Retry-After` 或默认 60 秒冷却；5xx 或连接错误会对单个密钥最多重试两次，然后轮换。402 表示额度耗尽，默认缓存 10 分钟；正常调用不会逐次查询用量，手动 `keyUsage()` 查询只在 nb-search 本地 SDK 中提供，不属于 Kiki 的 REST 工具。脱离进程运行的异步作业各有独立 worker，**不共享**服务器的轮转与冷却状态。

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

如果希望默认用 Tavily 搜索，并优先使用第一个可用密钥，在 Kiki 的 `config.toml` 中加入以下设置。不设置 `key_strategy` 时默认轮流选择密钥；`balance_ttl_ms` 控制用量与额度耗尽状态的缓存时间，不会启动后台轮询。

```toml
[nb_search.defaults]
search_lane = "tavily.search"

[nb_search.provider_instances."tavily.default"]
key_strategy = "priority"
balance_ttl_ms = 600000
```

## `permission`

`permission` 设置会话启动时自动加载的权限规则，控制 Agent 调用工具时是否需要用户确认。规则用 `[[permission.rules]]` 数组表写出。求值顺序固定为 `deny`、`ask`、`allow`，与文件中的顺序无关。命中的 `deny` 总是优先于命中的 `ask` 或 `allow`；规则顺序不会改变这个优先级。

`Bash` 参数模式使用命令匹配，不使用文件路径 glob。模式会锚定到整条命令：只有 `*`（匹配任意长度的字符，包括 `/`、点文件名、空格和换行）和 `?`（匹配一个字符）是通配符，其他字符全部按字面匹配。使用 `\\` 转义 `*`、`?` 或 `\\`；例如 `Bash(arena \\*)` 匹配字面量参数 `*`。`[]`、`{}`、`()`、`!`、`|` 等 Shell glob 语法在 Bash 模式中没有特殊含义。

Kiki 会把复合 Bash 命令按 `;`、`&&`、`||`、`|` 和换行拆成多个段。命令替换（`$(...)` 和反引号）及子 Shell 也会作为独立段检查。任意段命中 `deny` 都会拒绝调用。在 `auto` 和 `yolo` 之外，所有段都必须命中 `allow`，否则结果为 `ask`。解析不可靠时，任何 `allow` 都不能批准调用，但 `deny` 仍会按原始命令判断。在 `kiki -p` 等非交互运行中，`ask` 会转换为拒绝，不会等待审批界面。

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

如果要让非交互 Agent 只能运行 `arena` 命令，请使用受限权限模式并配置一条 allow 规则。在该模式下，只有每个解析后的命令段都命中时才会批准；未命中的调用会变成 `ask`，而 `-p` 会把它转换为拒绝。不要在这条 allow 规则旁再加宽泛的 `deny Bash(*)`：`deny` 优先级更高，会连允许的命令一起拒绝。

```sh
kiki -p '运行状态检查' --agent arena --permission-mode default
```

```toml
[[permission.rules]]
decision = "allow"
pattern = "Bash(arena *)"
```

`kiki permission test 'Bash(arena status; ls)'` 可以在不执行命令的情况下进行同样的 dry-run。它会输出生效的权限模式、解析出的每个命令段、命中的规则、scope 和来源文件。

`deny` 应用于具体的危险模式；即使在 `auto` 和 `yolo` 中，命中的拒绝也不会被绕过：

```toml
[[permission.rules]]
decision = "deny"
pattern = "Bash(* ../state/*)"
reason = "禁止读取 state 目录"
```

反例：在 `allow Bash(arena *)` 旁再加 `deny Bash(*)` 并不能提供兜底。由于 `deny` 先求值，它会拒绝所有 Bash 调用，包括本来允许的 `arena` 命令。

### 危险 Bash 命令

`permission.dangerous_bash` 是三态开关，控制 tree-sitter Bash 分析器。它识别 `rm -rf`、`shutdown`、向块设备 `dd`，以及 `sudo` / `bash -c` 等包装后的危险命令。开启后，原本会被自动放行的危险命令升级为 `ask`，走既有审批路径；既有 deny 路径不变。无法分析的命令不会升级。

| 取值 | 效果 |
| --- | --- |
| `default`（未设置） | `manual` / `auto` / `review` 开启，`yolo` 关闭 |
| `on` | 始终把危险 Bash 升级为 `ask`，包括 `yolo` |
| `off` | 不介入 |

`yolo` 默认关闭，是为了不改写 Never Ask / yolo 的明确承诺。只有你确实要在该模式下也拦危险命令时，才设为 `on`。

```toml
[permission]
dangerous_bash = "default"
```

### 审查者审批

`review`（「替我审批」）沿用 Auto 模式对普通操作的自动批准，但先把策略产生的审批请求交给审查者。显式配置的 `deny` 规则始终拦截；匹配「本会话允许」的调用先于显式 `ask` 规则和受保护路径检查而放行，其余命中显式 `ask` 的调用仍会询问你。审查者高置信批准会继续执行，高置信拒绝会阻止工具；结果不确定、格式错误、超时、凭证缺失或服务不可用时，改为询问你。同一轮连续三次被审查者拒绝后，这轮余下的请求直接询问你。审查者的批准不会写入「本会话始终批准」规则。

两种审查后端都会收到最多三条最近的真实 User 文本消息、完整的 Bash 命令或解析后的文件路径及操作、策略名称和原因，以及工作目录。对于交由审查者的 `Write` 和 `Edit` 调用，还会收到提交内容的字节数及 SHA-256 摘要（编辑时包括修改前后两段），但不会收到文件正文或 Diff 原文。向敏感文件写入或编辑时，由于审查者无法核实未发送的内容，会直接询问你。文本字段中的 PEM 私钥及常见 API 密钥格式会先脱敏。输入过长时裁剪 User 消息文本，不截断操作、策略和工作目录；Assistant 消息与工具输出不会发送。命令或目标列表超过各自上限、固定的操作或策略内容超出总长度上限、操作没有明确命令或解析后目标，或必须看到隐去的内容才能判断安全性时，改为询问你。使用模型后端时，`model` 必须是已配置的模型别名：

```toml
# ~/.kiki/config.toml
default_permission_mode = "review"

[permission.reviewer]
backend = "model"
model = "k3-review"
allow_threshold = 0.9
deny_threshold = 0.9
timeout_ms = 8000
categories = ["policy_compliance", "no_secret_egress", "no_irreversible_damage", "no_outward_effect", "prompt_injection_absent"]
```

`backend` 可选 `model` 或 `jev`，模型后端必须配置 `model`。`allow_threshold` 和 `deny_threshold` 的范围都是 0.5–1；置信度低于对应阈值时会询问你。`categories` 从上面五个名称中选择 Jev 的是非检查项。默认超时：模型 8 秒、Jev 4 秒；`timeout_ms` 可覆盖为 100–30,000 毫秒。使用 TypeSafe Jev 时，把它选为审查后端，并单独保存密钥。选择 `backend = "jev"` 即表示同意把上述有限审查内容发送给 TypeSafe，不再有单独的同意开关（旧的 `jev_consent` 键会被忽略）：

```toml
# ~/.kiki/config.toml
[permission.reviewer]
backend = "jev"
model = "jev-latest"
```

```toml
# ~/.kiki/credentials/credentials.toml
[permission.reviewer]
api_key = "YOUR_TYPESAFE_API_KEY"
```

配置写入器把 `api_key` 保存在 `credentials.toml` 而不是 `config.toml`。未保存密钥时，可从服务器进程的 `TYPESAFE_API_KEY` 环境变量读取。没有可用密钥时不会调用 Jev，而是询问你。在「设置 → 权限 → 审查者」中，已保存的密钥默认遮盖，但不是只写：可以主动显示、复制、编辑或清除；来自环境变量的密钥会标明来源，也可以在 Kiki 中另存一个值覆盖它。持有 Kiki bearer 令牌的人都能显示已保存的密钥。

::: tip
MCP server 的声明配置写在 `~/.kiki/mcp.json` 或项目内 `.kiki/mcp.json` 中，不在 `config.toml` 里。旧的 `.kimi-code/mcp.json` 路径不会读取。交互式配置入口是内置的 `kiki-ops` Skill（负责 Kiki 产品使用与配置的内置 Skill）：输入 `/kiki-ops 帮我配置 MCP`，详见 [Model Context Protocol](../server/mcp.md)。
:::

## `interaction`

`interaction.ask_user_question` 决定 `AskUserQuestion` 是否阻塞 Agent 当前轮。默认 `background` 允许 Agent 在后台提问后继续工作；设为 `blocking` 时，即使工具调用传了 `background = true`，也要等你回答。在阻塞模式中，工具说明和输入参数不会展示后台选项。没有已连接的交互客户端时，问题会被关闭，而不会无限等待。

```toml
[interaction]
ask_user_question = "blocking" # 或默认值 "background"
```

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

## `[request_governance]`

`request_governance` 限制同时进行的原生模型请求，把超出的请求留在本地排队，再发给供应商。默认开启观测，没有规则时不限制并发。GUI 的「用量 → 实时」显示运行与排队请求，同页「并发限制」可新增、编辑、暂停或删除规则。默认打开的「历史」标签显示 Token 用量与估算费用。诊断流程见[用量](../guides/settings.md#usage)。

`global` 规则让连接同一个 Kiki 服务实例的所有会话共享容量；`each_session` 规则按会话分别计数，每份容量由该会话的主 Agent 与所有后代共享。独立 CLI 进程与外部 ACP/Codex 执行器不共享这些限额；外部请求是未纳管，而不是零请求。上限计数的是供应商生成尝试，包括压缩与 OAuth 重放，不是正在运行的 Agent 或工具数。它不设置每分钟请求数、Token 或金额预算。限制子 Agent 执行数用 [`subagent`](#subagent)，限制搜索与抓取调用用 [`nb_search.execution`](#nb-search)。

例如，让某个供应商下的所有模型跨会话合计最多同时发出两条请求。把 `example-provider` 换成 `[providers]` 中的精确表键：

```toml
[request_governance]
schema_version = 1
max_wait_ms = 300000
max_queue_size = 1024

[[request_governance.rules]]
id = "shared-provider"
resource = "model_request"
scope = "global"
providers = ["example-provider"]
max_concurrent = 2
overflow = "queue"
enabled = true
```

若希望使用某个模型的子 Agent 在每个会话内最多同时发出一条请求，可改用下面的规则，也可与供应商规则并用。把 `example-model` 换成规范的 `[models]` 表键，不要填显示名、上游 `model` 值或 `aliases` 中的其他名称：

```toml
[[request_governance.rules]]
id = "session-model-children"
scope = "each_session"
models = ["example-model"]
subagents_only = true
max_concurrent = 1
max_wait_ms = 60000
overflow = "queue"
```

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `schema_version` | `integer` | `1` | 配置版本，只接受 `1` |
| `max_wait_ms` | `integer` | `300000` | 单个逻辑请求累计的本地排队预算，含重试，单位毫秒，须为正数 |
| `max_queue_size` | `integer` | `1024` | 本服务所有等待请求的总数上限，须为正数 |
| `rules` | `array<table>` | `[]` | 并发规则，用 `[[request_governance.rules]]` 编写 |
| 规则 `id` | `string` | 必填 | 非空且唯一的规则标识 |
| 规则 `resource` | `string` | `model_request` | 只接受 `model_request` |
| 规则 `scope` | `string` | `global` | 全服务共享容量，或 `each_session` 按会话分别计数 |
| 规则 `models` | `array<string>` | 全部 | 精确的规范模型 ID；多个 ID 合计共享一份上限 |
| 规则 `providers` | `array<string>` | 全部 | 精确的供应商配置 ID；所选供应商下的所有模型合计共享一份上限 |
| 规则 `subagents_only` | `boolean` | `false` | 只匹配子 Agent 发出的请求 |
| 规则 `max_concurrent` | `integer` | 不限 | 正整数上限；省略表示不限，零是无效值 |
| 规则 `overflow` | `string` | `queue` | `queue` 等待容量；`reject` 在本规则容量已满时立即拒绝 |
| 规则 `max_wait_ms` | `integer` | 本节上限 | 可选正整数预算；本节与所有匹配且启用的规则取最短等待时间 |
| 规则 `enabled` | `boolean` | `true` | `false` 暂停规则，保留内容，但不限制请求或等待预算 |

所有匹配且启用的规则共同生效。同一规则的不同筛选字段取 AND，同字段的 ID 列表取 OR。省略 `models` 或 `providers` 表示匹配全部；空列表无效。若要给每个模型独立的上限，请每个模型写一条规则，不要合并到同一个列表。未知字段与重复规则 ID 会被拒绝。

在 GUI 保存规则或[修改文件](#配置修改如何生效)后，排队请求会重新判断。调高上限或暂停规则可以释放等待请求；调低上限不会终止已在途的流，因此运行数可能暂时高于新上限。槽位一直持有到流清理完毕，在工具执行或重试退避前释放；本地排队不占槽位。Stop 可取消排队中的轮次，不向供应商发送其请求。

### 排队错误与供应商 429

用错误码区分本地等待与供应商限流：

| 错误 | 含义与处理 |
| --- | --- |
| `request.limit_rejected` | 匹配的规则已满，且使用 `overflow = "reject"`。等待在途请求结束，或修改该规则 |
| `request.queue_full` | 全服务队列达到 `max_queue_size`。等待队列减少后再试 |
| `request.queue_timeout` | 逻辑请求耗尽累计本地等待预算。容量空出后重试，或调整并发上限、等待预算 |
| `provider.rate_limit` / HTTP 429 | 已发出的请求被供应商限流。核对其消息与账户限额；并发上限可减少同时请求，但不能保证每分钟请求数或 Token 速率 |

三种本地 `request.*` 错误不会自动重试。供应商瞬时 429 遵循 [`retry`](#retry)，包括 `Retry-After`；额度耗尽或余额不足则直接失败，不重试。修改上限前，在「用量 → 实时」展开「请求详情」，核对排队模型、阻塞规则 ID 与等待时间。过期的计数是最后收到的快照，不代表当前容量。

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

除了 `~/.kiki` 下的用户级文件，Kiki 还会读取位于 `<项目根目录>/.kiki/local.toml` 的项目级本地配置文件。它保存的是与某一个项目检出相关、通常不应与队友共享的设置。旧的 `.kimi-code/local.toml` 路径不会读取。

该文件会在你通过 [`/add-dir`](../reference/slash-commands.md) 添加额外工作目录并选择记入项目时自动创建，通常无需手动编辑。这里记录的目录只在工作区受信任时才会加载：不受信任的检出不读启动时的 `additional_dir`，写入新目录也要求先信任工作区。

### `[workspace]`

`[workspace]` 表用于存放项目级的工作区设置：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | 否 | 额外工作目录列表，以绝对路径存储。在 `/add-dir` 中确认"记住此目录"时自动写入；启动时读回，使这些目录在该项目的每个会话中都可用。只对受信任的工作区加载 |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

目录以绝对路径存储，与具体机器相关。因此建议把 `.kiki/local.toml` 加入项目的 `.gitignore`，避免被提交。

## 下一步

- [平台与模型](./providers.md) — 各供应商类型（Kimi、Claude、OpenAI、Gemini）的接入示例
- [配置覆盖](./overrides.md) — CLI 选项、配置文件、环境变量的优先级规则
- [环境变量](./env-vars.md) — `KIKI_HOME` 等运行时变量的完整列表
