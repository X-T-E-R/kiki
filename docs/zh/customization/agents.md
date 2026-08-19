# Agent 与 subagent

Kimi Code CLI 中的每次会话都由一个**main agent** 驱动。main agent 理解用户意图、规划步骤、调用工具，并在需要时向外派发**subagent** 处理更聚焦的子任务——例如探索一个陌生代码库、并行审阅多处实现、或在不触碰主上下文的情况下规划一次大型重构。

subagent 接受 main agent 给出的任务描述，在自己的独立上下文里工作，最后把结论返回。它不会与用户直接对话，中间的思考和工具调用记录也不会混入 main agent 的历史。

## 内置 subagent

Kimi Code CLI 内置三种 subagent，开箱即用，分别面向不同任务形态：

- **`coder`**：默认 subagent，通用软件工程助手，可以读写文件、执行命令、搜索代码并落地具体改动。
- **`explore`**：代码库探索专用，只做只读操作，不修改任何文件。适合在不改动文件的前提下快速搜索、阅读和总结仓库。
- **`plan`**：实现规划与架构设计专用，连 Shell 命令都不提供，专注于"想清楚怎么做"而不是"动手做"。

`coder` subagent 与 main agent 共享大部分工具集：可以在后台执行 Shell 命令、维护待办列表、进入 Plan 模式、调用 Agent Skills，也可以在任务自然拆解时继续派发自己的嵌套 subagent。如果它结束自己的轮次时仍有后台任务在运行，那么只有在这些后台任务全部落定后，这次运行才会回报完成——main agent 拿到结果时，背后的工作也已经真正完成。

顶层配置 [`disabled_builtin_profiles`](../configuration/config-files.md#顶层字段) 会从 subagent 发现与派发列表中移除指定的内置 profile（`agent`、`coder`、`explore` 或 `plan`）。禁用 `agent` 不会影响 main agent 使用默认绑定启动；文件 profile 与已禁用内置 profile 同名时，不再需要 `override: true`。

## 调用方式

subagent 由 main agent 自动调度——根据任务复杂度、上下文消耗和子任务的独立性，在适当时机派发，无需用户手动指定。

每次派发都会在终端以审批请求的形式呈现（除非命中 allow 规则或处于 YOLO 模式），方便你审视任务描述。你也可以在对话中直接指示 main agent 使用特定 subagent，例如"先用 explore 把相关文件梳理一遍再动手"。

subagent 支持在后台运行：完成后结果自动回到 main agent，无需手动轮询。也可以唤回已有的 subagent 实例继续推进同一任务。

## Codex 风格协作适配器

`agent-collaboration` 实验功能在同一套子 Agent 与后台任务生命周期之上增加一层 Codex 风格适配器。设置 `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION=1` 启用；`[agents] enabled = false` 可以在不改实验 flag 的情况下关闭它。这是一层适配器，并不代表完整兼容 Codex。

负责协调的 `agent` 与 `coder` profile 会获得 6 个 snake_case 工具：`spawn_agent`、`list_agents`、`wait_agent`、`followup_task`、`interrupt_agent` 和 `send_message`。`spawn_agent` 始终异步启动，并使用全新上下文；它只接受 `fork_turns = "none"`，不会复制父 Agent 的对话历史。名称必须匹配 `^[a-z0-9_]+$`，不能是 `root`，并且在会话生命周期内保持唯一。

管理工具的 target 必须是精确的 `task_name` 或 `agent_id`，不支持相对路径或分层路径。每个调用方只能列出和管理自己直接创建的具名 Agent；同级 Agent 或其他调用方创建的子 Agent 都不是有效目标：

- `list_agents` 按 `task_name` 升序返回具名 Agent。
- `wait_agent` 默认等待 30 秒，`timeout_ms` 可设置为 10 秒至 1 小时。
- `followup_task` 只会在同一个空闲 Agent 身份上启动一轮新 turn。目标正在运行时会拒绝，不排队也不注入消息。
- `interrupt_agent` 只停止当前具名 turn。之后仍可继续使用同一个 Agent。
- `send_message` 会把消息持久排入具名 Agent 的队列，不会启动、steer 或中断其 turn。运行中的 Agent 会在下一个 step 边界收到排队消息；空闲 Agent 不会被唤醒，要等之后的 turn 到达该边界才会收到。

现有 `Agent` 与 `AgentSwarm` 工具保持不变。

## Peer thread 通信

Peer thread 通信让主 Agent 协调同一台本地主机上的现有 Kimi Code 会话，也可以跨工作区通信。它与上面的实验性具名 Agent 适配器相互独立，并且默认关闭。选择启用后，`list_threads`、`read_thread`、`send_message_to_thread` 和 `wait_threads` 这 4 个工具只提供给会话的主 Agent，不提供给子 Agent。

Thread 引用标识主机、工作区和会话。`list_threads` 返回后续调用所需的引用；`read_thread` 读取已完成的主 Agent turn，不会恢复冷会话；`send_message_to_thread` 从当前主 Agent 会话派生来源，并持久接收发往另一条 thread、带 peer 归属的消息；`wait_threads` 最多等待 8 条 thread 的活动，最长等待 60 秒。消息不能跨主机发送。

如需保留真实的 peer 归属，必须由来源 thread 的主 Agent 调用 `send_message_to_thread`。REST 或 Klient 的 `global.threads` facade 只接受目标 thread，提交的消息会记为 user 来源，外部客户端不能自行声明来源 thread。

在 `config.toml` 中设置 `[thread_communication] enabled = true` 可全局启用。发送消息可能会恢复冷会话并消耗模型额度。集成方还可以为单个工作区持久设置启用或禁用覆盖值；全局开关关闭时，工作区覆盖值不能重新启用该功能。接口说明见 [Kiki 运行时边界](../guides/kiki-runtime.md#集成-peer-thread-通信)。

## 上下文隔离与资源开销

每个 subagent 拥有完全独立的上下文窗口，只能看到 main agent 显式传入的任务描述，看不到 main agent 的对话历史。subagent 自己的中间思考和工具调用记录不会回流，只有最终结果会出现在 main agent 的上下文里。

这种隔离带来两个好处：

- **main agent 上下文保持精炼**，长会话中不会被大量探索性日志撑满。
- **多个 subagent 可以并行运行**，互不干扰。

需要注意的是，每个 subagent 都会独立消耗模型 token。简单任务没有必要派发 subagent，main agent 直接处理更经济。

## 权限继承

subagent 的权限规则继承自 main agent：main agent 通过 `/permission` 或在审批中接受的"始终允许"规则，会自动覆盖到它派发出的所有 subagent，subagent 不需要重新审批同类工具调用。`Agent` 工具本身默认放行，因此 main agent 可以在不打断用户的前提下完成多次委派。

如果需要某类工具在 subagent 中始终不可用，应收紧 main agent 的权限规则。

## 自定义 Agent

除了三个内置 subagent，你还可以用 Markdown 文件定义自己的 Agent。每个文件描述一个 Agent：文件顶部的 Frontmatter（YAML 元数据）声明名称、描述和工具权限，文件正文是它的系统提示词。自定义 Agent 可以作为 subagent 被委派 —— main agent 会自动发现它们，与内置 subagent 并列 —— 也可以在启动时选为 main agent。

### Agent 目录

Kimi Code CLI 按作用域发现 Agent 文件，作用域越具体，优先级越高：**显式（`--agent-file`）> 项目 > 额外 > 用户 > Plugin > 内置**。两个文件定义了相同的 `name` 时，高优先级作用域胜出。每个目录都会递归扫描 `.md` 文件。

**用户级**（对所有项目生效）：
- `$KIMI_CODE_HOME/agents/`（默认：`~/.kimi-code/agents/`）
- `~/.agents/agents/`

Kimi 专属的用户 Agent 目录随 `KIMI_CODE_HOME` 移动，通用的 `~/.agents/agents/` 目录留在真实用户目录下，便于跨工具共享。

**项目级**（项目根目录 = 从工作目录向上查找、最近的包含 `.git` 的目录）：
- `.kimi-code/agents/`
- `.agents/agents/`

**额外目录**：在 `config.toml` 顶层通过 `extra_agent_dirs` 声明：

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

用户、项目和 `extra_agent_dirs` 根目录下的 Agent Markdown 文件都会被文件系统监听。新增、修改或删除后，经过约 200 ms 去抖会自动重载，因此运行中的会话无需执行 `/reload` 或重启 CLI，就能派发新出现的角色。`$KIMI_CODE_HOME/SYSTEM.md` 也以相同方式监听。已经创建的 `Agent` 工具实例会保留角色描述列表的冻结快照，因此展示可能暂时滞后，但实际派发会立即使用重载后的 profile。

**Plugin 级**：已启用 plugin 在其 manifest 的 `agents` 字段中声明的目录（省略时自动采用 plugin 根下的 `agents/` 目录），见[插件 Agent](./plugins.md#插件-agent)。Plugin Agent 优先级仅高于内置 Agent。

**内置 Agent** 随 CLI 分发，优先级最低。目录中发现的文件不会仅凭同名覆盖内置 Agent；如确需替换，必须在 Frontmatter 中声明 `override: true`。通过 `--agent-file` 加载的文件视为显式启动意图，可以覆盖同名内置 Agent，优先级高于所有目录作用域，且仅对本次启动生效。另外，`$KIMI_CODE_HOME/SYSTEM.md` 可永久覆盖默认 main agent 的系统提示词（它不参与 Agent 文件发现），其优先级交互见下文 SYSTEM.md 小节。

::: warning 信任模型
Agent 文件属于提示词配置，而项目级文件来自仓库本身 —— 包括你刚刚 clone、尚不可信的仓库。项目作用域的文件可以完全接管内置 Agent：命名为 `agent.md` 并声明 `override: true` 会替换**默认 main agent 的整个系统提示词**，`coder.md` 加 `override: true` 则会替换默认 subagent 类型。与 `AGENTS.md` 内容（作为参考资料注入提示词）不同，override 文件**就是**系统提示词本身，且不写 `tools` 的文件保留全部工具。在不熟悉的仓库中运行 Kimi Code 之前，请以对待脚本同样的谨慎检查其中的 `.kimi-code/agents/` 与 `.agents/agents/` 目录。
:::

### Agent 文件格式

Agent 文件是带 Frontmatter 的普通 Markdown：

```markdown
---
name: reviewer
description: 严格的代码审查 Agent，按严重度分级报告问题
whenToUse: 代码评审与 PR 检查
override: false
model_alias: fast-model
thinking_effort: low
tools:
  - Read
  - Grep
  - Glob
  - mcp__github__*
disallowedTools:
  - Bash
---

你是严格的代码审查者。阅读 diff 后，按严重度分级报告问题……
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | kebab-case 唯一标识。缺省时取文件名（去掉扩展名，如 `review.md` → `review`）；解析后名字缺失或不是 kebab-case 的文件会被跳过并告警 |
| `description` | 是 | Agent 的用途。main agent 挑选 subagent 时会看到，请围绕委派决策来写 |
| `whenToUse` | 否 | 补充说明何时应使用该 Agent |
| `override` | 否 | 是否允许覆盖同名内置 Agent，默认 `false`。`--agent-file` 属于显式启动意图，无需设置此字段 |
| `model_preference` | 否 | 仅在次主力模型实验功能启用时可用的旧版符号选择器：`primary` 继承调用方的模型绑定，`secondary` 选择 [`[secondary_model] model`](../configuration/config-files.md#secondary-model)。与 `model_alias` 互斥 |
| `model_alias` | 否 | `[models]` 中区分大小写的精确 alias。名为 `primary` 或 `secondary` 的 alias 仍按字面值处理，与符号字段 `model_preference` 不同 |
| `thinking_effort` | 否 | 该 profile 作为新子 Agent 启动时请求的 thinking effort，与模型选择器独立解析 |
| `recommended_models` | 否 | 建议性的备选模型列表，供父 Agent 作为 `Agent.model_alias` 传入。每个条目是一个 mapping，必填 `alias` 与 `when`，可选 `thinking_effort`。只有在本机 `[models]` 表中能解析的 alias 才会出现在 `Agent` 工具说明里；全部无法解析时整行省略。它不绑定模型，不改变启动时的模型解析，也不会写进子 Agent 的提示词。只支持 YAML mapping 列表，不支持逗号分隔字符串。alias 相同但 `thinking_effort` 不同的条目按两条保留 |
| `service_tier` | 否 | 该 profile 作为子 Agent 运行时每个 LLM 请求携带的服务档位：`auto`、`default`、`flex` 或 `priority`。目前只有 `openai_responses` 协议会把它编码进请求体，其他协议静默忽略 |
| `request_params` | 否 | 附加请求参数，标量 map（值只允许字符串 / 数字 / 布尔值），该子 Agent 的每个请求都会携带。OpenAI 系协议展开进请求体（Kimi 经 `extra_body`），不会覆盖引擎生成的字段；Anthropic 协议静默忽略；与 `service_tier` 等一等字段冲突时一等字段优先。键名原样发送，provider 可能拒绝它不认识的键 |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。支持 YAML 列表或逗号分隔字符串（`tools: Read, Grep`）两种写法。缺省表示允许全部工具；单独的 `*` 同样表示允许全部工具；空列表（`tools: []`）表示禁用全部工具 |
| `disallowedTools` | 否 | 禁止列表，写法与匹配规则相同，在 `tools` 之后应用 |
| `subagents` | 否 | 允许委派的子 Agent 名称列表，写法与 `tools` 相同（YAML 列表或逗号分隔字符串）。省略字段或单独写 `*` 表示不限制；空列表（`subagents: []`）表示禁止派发任何子 Agent；其他显式名称构成白名单 |

`recommended_models` 是一个 YAML mapping 列表。顶层写成字符串、标量或单个 mapping 都是非法的，因为每个条目都需要 `when` 触发条件。示例：

```yaml
recommended_models:
  - alias: fast-model
    when: 范围与验收标准已经明确，快速给出结论比等待更划算。
    thinking_effort: high
  - alias: k3-review
    when: 默认 alias 自己就能完成的常规评审。
```

内置工具与用户工具按名称精确匹配（区分大小写）；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。有三种写法永远匹配不到任何工具，在 profile 生效时会给出警告：`mcp__` 模式之外使用通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）；不是完整 `mcp__<服务器>__<工具>` 形式的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具 —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建提示词时都会作为模板渲染：`${var}` 占位符替换为实时上下文值——未知变量保持原样，单独的 `$` 没有特殊含义，上下文中缺失的变量渲染为空字符串。`${base_prompt}` 会在你放置它的位置嵌入有效默认系统提示词（内置默认，或存在时为你的 `SYSTEM.md` 覆盖），因此文件可以"包裹"默认行为而不是替换它。如果文件会替换默认提示词、但仍要保留已启用 plugin 提供的指令，请把 `${plugin_sections}` 放在希望出现这些指令的位置。可用变量见下文 SYSTEM.md 变量表。

未知字段会被忽略，新版本写的文件在旧版本上仍可读取。其他 Agent 工具的字段（如 Claude Code 的 `model`、OpenCode 的 `mode`）同样会被忽略；加上 `tools` 的逗号分隔写法和 `name` 缺省回退到文件名，Claude Code 与 OpenCode 风格的 Agent 文件一般可直接加载 —— 只含 `description` 和正文的最小文件可跨工具通用。

### 具名 profile route（实验功能）

具名 route 在现有 Agent 上增加专用运行方式，但不会创建新的权限身份。启动时在 `config.toml` 中设置 `[experimental] agent-profile-routes = true`，或设置 `KIMI_CODE_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`。

基础 profile 仍放在 `agents/<role>.md`。Route 放在 `agents/.routes/<role>/<route>.md`，规范 ID 为 `<role>.<route>`，每一段都必须是小写 kebab-case。例如 `agents/.routes/reviewer/ui-k3.md` 定义 `reviewer.ui-k3`：

```markdown
---
id: reviewer.ui-k3
profile: reviewer
description: 使用 K3 模型审查 UI 改动
whenToUse: 前端与交互评审
prompt_mode: prepend
model_alias: k3-review
thinking_effort: high
tools: [Read, Grep, Glob]
disallowedTools: [Bash]
subagents: [explore]
service_tier: priority
request_params:
  temperature: 0.2
---

重点检查交互回归、无障碍与视觉一致性。
```

必填字段为 `id`、`profile`、`description` 和 `prompt_mode`。可选字段为 `whenToUse`、`model_preference`、`model_alias`、`thinking_effort`、`service_tier`、`request_params`、`tools`、`disallowedTools`、`subagents`。与普通 Agent 文件不同，route Frontmatter 使用严格解析。未知字段、非法类型、路径 / ID / profile 不匹配、同一来源内重复 ID、互斥的模型选择器只会让该 sidecar 被跳过并产生带 code 的诊断；基础 profile 和其他 route 仍会加载。`recommended_models` 等仅属于 Agent 文件的字段在这里属于未知字段，会导致该 sidecar 被跳过。

`prompt_mode` 始终保留基础提示词：`inherit` 要求正文为空；`prepend` 与 `append` 要求正文非空且不能包含 `${base_prompt}`；`wrap` 要求正文必须且只能包含一次 `${base_prompt}`。不提供无保护的 replace 模式。

Route 只能收紧权限。Route 的 `tools` 是额外 allow 层（基础与 route 必须同时允许某个工具）；`disallowedTools` 与基础 denylist 合并；`subagents` 与基础 allowlist 取交集，`subagents: []` 会让 route 成为叶子。调用方检查仍针对基础 role，因此 route 不能引入调用方原本不能派发的 role。需要更大权限时，应新建并 allowlist 一个基础 profile。

请求字段省略时继承基础值。`service_tier: null` 清除基础 tier，其他值直接替换；`request_params: null` 清除基础 map，传入 map 时按标量 key 覆盖。Route 声明的 `model_alias` 或 `thinking_effort` 会被锁定：调用可以省略或重复同一值，但冲突值会被拒绝。锁定的 alias 不存在时会在分配 Agent 之前报错，不会走普通 profile alias 的回退逻辑；所选模型无法精确执行锁定 effort 时，派发同样会失败。

启用后，`Agent` 与 `AgentSwarm` 都会列出经调用方基础 role allowlist 过滤后的精简 route 条目。条目只包含 route ID、基础 role、描述 / 使用提示、模型与 effort 默认值、被覆盖的字段名，绝不包含提示词正文。调用时传入 `route: reviewer.ui-k3`；可以省略 `subagent_type` 让系统推导 `reviewer`，也可以显式传入这个匹配的基础 role。Role 不匹配会产生带 code 的错误。系统不会自动排序选择或静默回退。

恢复时不会重新选择或切换 route。Journal 会保存规范基础 role、route ID、渲染后的提示词、分层工具策略、denylist、子 Agent 限制、模型 / effort 锁、service tier 与请求参数。因此，即使后来关闭 flag，或 sidecar 被修改、删除、写坏，已有 routed Agent 仍从快照恢复；这些变化只影响新派发。旧 journal 继续兼容。混合 `AgentSwarm` 调用只把 `route` 应用于基于 item 的新 Agent，resume 条目保留原快照。

`model_alias` 与 `thinking_effort` 已是稳定的 profile 字段和 `Agent` / `AgentSwarm` 工具参数，不需要启用 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`。新派生子 Agent 的模型与 effort 分别按以下顺序解析：工具参数 → profile 字段 → `[subagent]` 的 `default_model` / `default_effort` → 调用方绑定。普通（非 route）profile 指定的 `model_alias` 不存在于 `[models]` 时，CLI 会告警并回退到调用方的模型与 effort；通过工具参数显式传入未知 alias 时则会报错。

只有旧版工具参数 `model`（`primary` / `secondary`）、profile 字段 `model_preference` 和次主力 recipe 仍受次主力模型实验功能控制。启用后，次主力 recipe 会插在 `[subagent]` 默认值与调用方绑定之间。关闭时，profile 中的 `model_preference` 会被忽略并告警；显式传入 `model` 工具参数则会返回清晰错误。恢复或重试的子 Agent 保持已持久化的模型与 effort；`Agent` resume 传入绑定字段会被拒绝。`AgentSwarm` 混合调用只把这些字段应用到基于 item 的新派生项。

subagent 模型治理会先解析 `[models]` alias，再按规范模型身份比较，共有三档：`[subagent] deny_models` 在所有派发入口拒绝对名单内模型的显式选择；`[secondary_model] enforce_pool = true` 把已配置池变成硬白名单，同时始终保留 `primary`；默认软白名单模式则继续允许精确的池外 `model_alias` 作为逃生通道。`[secondary_model] force = true` 仍是最强的单模型钉死策略，会把所有派生绑定到同一模型，且不能与 `enforce_pool` 同设。字段与校验规则见[配置参考](../configuration/config-files.md#secondary-model)。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。`subagents` 同样双重生效：`Agent` 工具的类型列表只包含允许委派的 subagent，`Agent` 与 `AgentSwarm` 在实际派发前都会强制校验；唤回已有 subagent 不受此限制。权限规则仍是独立的控制层，用于决定哪些操作需要审批。
:::

作为 subagent 委派的自定义 Agent 不会携带内置 subagent 的角色框架（"你的最后一条消息就是完整交付"）。如果编写的 Agent 用于委派，请在正文中说明：其最后一条消息应当是交付给调用方的完整、自包含的结果。

### 选择 main agent

两个 CLI flag 用于选择驱动新会话的 Agent，在 print 模式（`kimi -p`）和交互式 TUI 中均可使用：

- **`--agent <name>`**：以指定 Agent 作为 main agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。该 flag 只接受一个文件：不可重复传入，也不能与 `--agent` 同时使用。

两个 flag 都仅在新建会话时有效——都不能与 `--session`/`--continue` 组合。Agent 在会话创建时绑定，恢复会话时会自动还原已绑定的 Agent，因此恢复时不需要（也不允许）携带这些 flag。

例如：

```sh
kimi --agent reviewer
kimi -p --agent reviewer "审查这个分支上的改动"
```

绑定的 Agent 即会话的身份：在会话首次绑定后即固定，之后不可切换。在 TUI 中，这些 flag 只绑定启动时的会话；之后在同一进程内新建的会话（例如通过 `/new`）使用默认 Agent。

定制 main agent 时，在正文中引用 `${base_prompt}` 可保持有效默认提示词中已有的环境、工作区指令、Skill 和 plugin 注入生效。如果要替换默认提示词、但只保留 plugin 提供的指令，请改用 `${plugin_sections}`。正文同时不引用 `${base_prompt}` 和 `${plugin_sections}` 时，会完全拥有自己的提示词并排除 plugin 指令，适合自包含的 subagent。

### 用 SYSTEM.md 覆盖 main agent 的系统提示词

希望永久覆盖 main agent 的系统提示词、而不必每次启动都传入 `--agent` 或 `--agent-file` 时，可以写一份 `$KIMI_CODE_HOME/SYSTEM.md`（默认：`~/.kimi-code/SYSTEM.md`，随 `KIMI_CODE_HOME` 移动）。文件存在且非空期间，它整体替换内置默认 main agent 的系统提示词——但只替换提示词，描述、工具集与允许委派的 subagent 列表仍沿用内置默认值。SYSTEM.md 在包括交互式 TUI 会话在内的所有启动方式下生效。

SYSTEM.md 是纯 Markdown 正文，不需要也不读取 Frontmatter。文件缺失或为空时不生效；读取失败时会告警并回退到内置提示词。优先级上，显式意图仍然胜出：项目作用域中声明了 `override: true` 的同名 Agent 文件、通过 `--agent-file` 传入的文件都排在 SYSTEM.md 之前，用 `--agent` 选择其他 Agent 时 SYSTEM.md 也不会生效；而在用户作用域内部，SYSTEM.md 优先于 `agents/` 目录中扫描到的同名文件。

与普通 Agent 文件的正文一样，SYSTEM.md 在每次构建提示词时作为模板渲染——正文中的 `${var}` 占位符会被替换为实时上下文：

| 变量 | 内容 |
| --- | --- |
| `${skills}` | 合并后的 Agent Skills 注入内容；`Skill` 工具不可用时为空 |
| `${agents_md}` | 工作区指令文件（如 `AGENTS.md`）的内容 |
| `${cwd}` | 当前工作目录 |
| `${cwd_listing}` | 工作目录的文件列表 |
| `${os}` | 操作系统类型 |
| `${shell}` | Shell 名称与路径，例如 `bash (\`/bin/bash\`)` |
| `${now}` | 当前时间（ISO 格式） |
| `${additional_dirs_info}` | 加入工作区的额外目录信息；没有时为空 |
| `${base_prompt}` | 默认系统提示词。在 `SYSTEM.md` 中指内置默认提示词；在 Agent 文件中指有效默认提示词（内置默认，或存在时为你的 `SYSTEM.md` 覆盖） |
| `${plugin_sections}` | 已启用 plugin 提供的完整 Plugin Instructions 块；没有已启用 plugin 提供指令时为空 |

未知变量原样保留，单独的 `$` 没有特殊含义；上下文中缺失的变量渲染为空字符串。另有四个预组合块——`${windows_notes}`、`${additional_dirs_section}`、`${skills_section}`、`${plugin_sections}`——渲染对应的内置提示词段落，不适用时为空字符串。内置默认提示词已经包含 `${plugin_sections}`；当 `${base_prompt}` 已展开为该提示词时，不要再重复加入此变量。利用这些变量可以重建内置提示词的骨架，例如：

```markdown
You are Kimi, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## 指令文件

全局 Kimi 专属指令可放在 `$KIMI_CODE_HOME/AGENTS.md`（默认：`~/.kimi-code/AGENTS.md`）。当你用 `KIMI_CODE_HOME` 移动数据根时，这份全局指令文件也会一起移动。跨工具通用指令仍可放在真实 OS home 下的 `~/.agents/AGENTS.md`，项目级指令仍放在项目目录中，例如 `.kimi-code/AGENTS.md` 或 `AGENTS.md`。

## 会话目录中的存储位置

subagent 的运行状态持久化到当前会话目录的 `agents/` 子目录下，每个 subagent 实例对应一个独立目录，其中包含按时间顺序记录提示词、消息历史与最终状态的 `wire.jsonl` 文件。后台 subagent 还会通过 `tasks/` 子目录暴露生命周期状态。

::: warning 注意
会话目录、wire 文件和任务记录都属于本地调试材料，可能包含用户 prompt、命令输出、仓库路径、工具返回内容或凭证痕迹。不要把这些文件直接提交到公开仓库、issue 或聊天记录里；如确需分享，请先脱敏。
:::

## 下一步

- [Hooks](./hooks.md) — 在 subagent 完成等关键节点触发本地脚本通知或拦截
- [Agent Skills](./skills.md) — 给 subagent 注入专业知识和工作流程
