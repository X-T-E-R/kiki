# Agent 与 subagent

Kiki 中的每次会话都由一个**main agent** 驱动。main agent 理解用户意图、规划步骤、调用工具，并在需要时向外派发**subagent** 处理更聚焦的子任务——例如探索一个陌生代码库、并行审阅多处实现、或在不触碰主上下文的情况下规划一次大型重构。

subagent 接受 main agent 给出的任务描述，在自己的独立上下文里工作，最后把结论返回。它不会与用户直接对话，中间的思考和工具调用记录也不会混入 main agent 的历史。

第一次接触 Kiki 的 agent 体系时，建议先读 [Agent profile 概念与设计](./agent-profiles.md)——它解释 profile 是什么、文件放在哪里、改动何时生效；本页是字段与行为参考。

## 内置 subagent

全新安装包含主 `agent` profile 和两个 subagent profile：

- **`general`**：默认 subagent，通用助手，可以读写文件、执行命令和搜索代码，但不能继续派发子 Agent。
- **`explore`**：只读代码库探索、搜索与总结专用。

另有两个**可选示例**，不是预装角色：`implementer` 负责工程任务，直到完成验证与交付；`reviewer` 作为只读叶子角色，独立审查决策或已完成的工作。GUI 首次启动后的 `/kiki-ops` 对话会分别询问是否创建它们。只有你同意某个角色后，Agent 才会从内置 `kiki-profile` skill 获取完整模板，在 `$KIKI_HOME/agents/<角色>.md`（默认 `~/.kiki/agents/`）创建对应文件；若文件已存在，不会擅自覆盖。两个模板都显式写有 `model_alias: inherit`：创建后的角色会跟随父 Agent 派发时使用的模型，而不固定供应商或具体模型。模板不设置 `thinking_effort`；以后可在设置中改为固定模型。

顶层配置 [`skip_builtin_profile_installation`](../configuration/config-files.md#顶层字段) 会跳过向 `agents/builtin/` 安装指定的内置模板，但不会禁用或删除已有副本。若要从 subagent 发现与派发列表中隐藏已安装的 profile，请使用 `disabled_named_profiles`；默认 main `agent` 绑定仍可使用。

## 调用方式

subagent 由 main agent 自动调度——根据任务复杂度、上下文消耗和子任务的独立性，在适当时机派发，无需用户手动指定。

每次派发都会在终端以审批请求的形式呈现（除非命中 allow 规则或处于 YOLO 模式），方便你审视任务描述。你也可以在对话中直接指示 main agent 使用特定 subagent，例如"先用 explore 把相关文件梳理一遍再动手"。

subagent 支持在后台运行：完成后结果自动回到 main agent，无需手动轮询。也可以唤回已有的 subagent 实例继续推进同一任务。

## 具名子 Agent

默认的 v2 引擎（Kiki 桌面端和 `kiki` CLI/TUI）会给主 `agent` profile 提供三个子 Agent 工具，不需要实验开关：`AgentRun`、`AgentList` 和 `AgentSend`。内置 subagent profile 没有它们。每个调用方只能列出和发消息给自己直接创建的子 Agent；孙级或别人创建的子 Agent 都不是有效目标。已退役的 `AgentSwarm` 可调用工具不再支持新调用，但历史 swarm 子 Agent 记录仍可读取。

`AgentRun` 用来启动新的子 Agent，或继续已有的。每次调用都必须提供 `prompt` 和用于界面展示、长度为 3–5 个词的短 `description`。新派生还可以设置 `profile`（省略时，显式配置的 `[subagent].default_profile` 会选择对应 profile；该配置键不存在时使用内建通用 subagent 提示词；显式留空时必须指定目标）、`profile_file`（显式 subagent role Markdown 文件，绝对路径或工作区相对路径；它是 role 定义而非共享提示词模板，并且与 `profile`、`route`、`resume` 互斥）、`route`、`name`、`background`、`model_alias` 和 `effort`。`allow_model_change` 仅在 `resume` 同时显式传入 `model_alias` 时有意义；该 alias 解析到不同规范模型时必须传入它。预计之后还要再找同一个子 Agent 时传入 `name`；名称必须匹配 `^[a-z0-9_]+$`，不能是 `root`，并且在会话内保持唯一。继续直属子 Agent 时，把 `resume` 设为它的名称或 agent id；它与 `name`、`profile`、`profile_file` 和 `route` 互斥。省略 `effort` 会保留已保存的 effort，也可以传入让下一次空闲运行使用。省略 `model_alias` 会保留已保存的模型；切换到不同规范模型必须传 `allow_model_change: true`，而解析到同一规范模型则不产生变化。Role 的模型 / effort 指引，以及 route 与 caller lease 的 pin 都属于软建议：只要实际绑定可执行，显式覆盖会继续运行并产生结构化告警。机器级 `[subagent].deny_models`、缺失或不受支持的模型能力、route 身份、换模确认，以及 executor / thread 限制仍是硬错误。外部 executor 不支持修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。新派生项的模型来自 `model_alias` 参数或生效 profile / route / caller lease 上的 pin，参数优先；两者都没有时调用以 `model.not_configured` 失败，不会创建子 Agent。effort 独立解析：工具 `effort` → profile `thinking_effort` → 所绑定模型自身的默认档位。显式传入未知 `model_alias` 时会报错。传入 `background: true` 可让任务在后台运行，否则父 Agent 会等待结果。Agent 任务默认 2 小时超时，通过 `[subagent] timeout_ms` 或 `KIKI_SUBAGENT_TIMEOUT_MS` 配置全局限制（`0` 表示禁用），print 模式默认无超时；不提供单次调用 timeout 或任意供应商参数透传。

`AgentList` 返回这些直属子 Agent，包括保留的历史 swarm 条目。默认 `include_finished=false` 列出运行中的，以及没有跟踪任务的；需要已经结束或失败的，再传 `true`。最多返回 50 条，运行中的排在前面。

`AgentSend` 把消息排进邮箱，投递语义是尽早送达：子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn；空闲的子 Agent 不会被唤醒，消息到下一步开始时才读。用 `name` 或 agent id 指定目标。

`AgentNotify` 方向相反，且只有 subagent 可用：它把一条 fire-and-forget 消息排进父 Agent 的邮箱，父 Agent 正在运行时会在下一个 step 边界注入其活跃 turn，空闲时则在下一次运行时读取。Main agent 没有父 Agent，永远不会拿到这个工具。在 `config.toml` 中设置 `[agents] notify_parent = false` 可以全局关闭它，默认开启。

## Peer thread 通信

Peer thread 通信让主 Agent 协调同一台本地主机上的现有 Kiki 会话，也可以跨工作区通信。它与上面的子 Agent 工具相互独立，并且默认关闭。选择启用后，`ThreadList`、`ThreadRead`、`ThreadSend` 和 `ThreadWait` 这 4 个工具只提供给会话的主 Agent，不提供给子 Agent。

Thread 引用标识主机、工作区和会话。`ThreadList` 返回后续调用所需的引用；`ThreadRead` 读取已完成的主 Agent turn，不会恢复冷会话；`ThreadSend` 从当前主 Agent 会话派生来源，并持久接收发往另一条 thread、带 peer 归属的消息；`ThreadWait` 最多等待 8 条 thread 的活动，最长等待 60 秒。消息不能跨主机发送。

如需保留真实的 peer 归属，必须由来源 thread 的主 Agent 调用 `ThreadSend`。REST 或 Klient 的 `global.threads` facade 只接受目标 thread，提交的消息会记为 user 来源，外部客户端不能自行声明来源 thread。

在 `config.toml` 中设置 `[thread_communication] enabled = true` 可全局启用。发送消息可能会恢复冷会话并消耗模型额度。集成方还可以为单个工作区持久设置启用或禁用覆盖值；全局开关关闭时，工作区覆盖值不能重新启用该功能。接口说明见 [服务 API](../server/rest-api.md#会话租约与-peer-thread)。

## 上下文隔离与资源开销

每个 subagent 拥有完全独立的上下文窗口，只能看到 main agent 显式传入的任务描述，看不到 main agent 的对话历史。subagent 自己的中间思考和工具调用记录不会回流，只有最终结果会出现在 main agent 的上下文里。

这种隔离带来两个好处：

- **main agent 上下文保持精炼**，长会话中不会被大量探索性日志撑满。
- **多个 subagent 可以并行运行**，互不干扰。

需要注意的是，每个 subagent 都会独立消耗模型 token。简单任务没有必要派发 subagent，main agent 直接处理更经济。

## 权限继承

subagent 的权限规则继承自 main agent：main agent 通过 `/permission` 或在审批中接受的"始终允许"规则，会自动覆盖到它派发出的所有 subagent，subagent 不需要重新审批同类工具调用。`AgentRun` 工具本身默认放行，因此 main agent 可以在不打断用户的前提下完成多次委派。

如果需要某类工具在 subagent 中始终不可用，应收紧 main agent 的权限规则。

## 自定义 Agent

除了随附的 profile，你还可以用 Markdown 文件定义自己的 Agent。每个文件描述一个 Agent：文件顶部的 Frontmatter（YAML 元数据）声明名称、描述和工具权限，文件正文是它的系统提示词。自定义 Agent 可以作为 subagent 被委派 —— main agent 会自动发现它们，与内置 subagent 并列 —— 也可以在启动时选为 main agent。

### 派遣能力可见性

GUI 的 main agent 选择器使用当前工作区或工作目录的有效 Agent 配置。主档具有 `main: true`。文件覆盖内置 profile 时，省略 `main` 会继承内置值，显式的 `main: false` 则会保留。因此，`SYSTEM.md` 无需额外 Frontmatter 就能保持默认 `agent` 的主档身份。从 subagent 发现目录中移除默认 profile，不会移除其主绑定，也不会丢弃已生效的文件覆盖；其他已禁用 profile 仍不可用。字段定义见 [Agent 文件格式](#agent-文件格式)。

在「设置 → 智能体」中选择工作区，可以查看默认主档、实际来源与 subagent 能力。文件 profile 的编辑会作用于界面所示来源；编辑遗留 `SYSTEM.md` 的常用字段时，会添加 Frontmatter 并保留提示词正文。已选配置后来不可用时，原值仍会保留并显示诊断，方便重新选择。

### 重建会话上下文

修改提示词来源后，在会话作曲器中打开 profile 选择器并选择「重建上下文」。二次确认后，Kiki 会从磁盘重新加载当前 profile、提示字段覆写、Agent Skills、`AGENTS.md` 指令，以及 plugin 的提示词和 session-start 注入，重新协调其他运行时上下文注入，并让后续请求使用重建后的快照。对话消息会保留。轮次运行期间此操作不可用；请等待会话空闲后重试。

在设置页、新会话的工作区选择器旁或会话右栏展开「派遣能力」，可以查看 subagent 配置、路由、执行器，以及默认模型和思考强度的来源。默认配置是否有效、当前是否允许启动会分别显示。草稿面板仅供规划参考，不是实时启动检查。

会话面板反映当前 Agent 的工具目录，包括 [Plan 模式下的只读研究限制](../reference/tools.md#plan-模式) 和拒绝启动的原因，但不检查外部供应商的健康状况。已选模型、Agent 配置或思考强度不可用时，发送前需重新选择；仅仅加载中或目录请求失败，不会让已保存的选择失效。

### Agent 目录

Kiki 按作用域发现 Agent 文件，作用域越具体，优先级越高：**显式（`--agent-file`）> 项目 > 额外 > 普通用户文件 > 内置副本（用户作用域）> Plugin**。两个文件定义了相同的 `name` 时，高优先级作用域胜出。每个目录都会递归扫描 `.md` 文件。

**用户级**（对所有项目生效）：
- `$KIKI_HOME/agents/`（默认：`~/.kiki/agents/`）
- `~/.agents/agents/`

Kiki 专属的用户 Agent 目录随 `KIKI_HOME` 移动，通用的 `~/.agents/agents/` 目录留在真实用户目录下，便于跨工具共享。

**项目级**（项目根目录 = 从工作目录向上查找、最近的包含 `.git` 的目录）：
- `.kiki/agents/`
- `.agents/agents/`

**额外目录**：在 `config.toml` 顶层通过 `extra_agent_dirs` 声明：

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

用户、项目和 `extra_agent_dirs` 根目录下的 Agent Markdown 文件都会被文件系统监听。新增、修改或删除后，经过约 200 ms 去抖会自动重载，因此运行中的会话无需执行 `/reload` 或重启 CLI，就能派发新出现的角色。`$KIKI_HOME/SYSTEM.md` 也以相同方式监听。已经创建的 `AgentRun` 工具实例会保留角色描述列表的冻结快照，因此展示可能暂时滞后，但实际派发会立即使用重载后的 profile。

**Plugin 级**：已启用 plugin 在其 manifest 的 `agents` 字段中声明的目录（省略时自动采用 plugin 根下的 `agents/` 目录），见[插件 Agent](./plugins.md#插件-agent)。Plugin 定义优先级低于用户文件，也低于已安装的内置副本。

**内置副本** 安装在 `$KIKI_HOME/agents/builtin/`，作为用户作用域的文件加载。它们在两个用户目录中的普通文件之后扫描，因此同名用户定义始终优先，无需 `override: true`，也不受文件名字母序或安装时间影响。同名冲突诊断会列出双方路径。通过 `--agent-file` 加载的文件优先于所有目录作用域，且仅对本次启动生效。另可通过 `$KIKI_HOME/SYSTEM.md` 永久覆盖默认 main agent 的系统提示词，优先级交互见下文。

::: warning 信任模型
Agent 文件属于提示词配置，而项目级文件来自仓库本身 —— 包括你刚刚 clone、尚不可信的仓库。项目作用域的文件可以完全接管内置 Agent：名为 `agent.md` 的文件可以替换**默认 main agent 的整个系统提示词**，`general.md` 可以替换默认 subagent 类型，无需声明 `override: true`。与 `AGENTS.md` 内容（作为参考资料注入提示词）不同，override 文件**就是**系统提示词本身；不写 `tools` 表示不在适用的运行时策略之外增加 profile 白名单限制。在不熟悉的仓库中运行 Kiki 之前，请以对待脚本同样的谨慎检查其中的 `.kiki/agents/` 与 `.agents/agents/` 目录。
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
| `override` | 否 | 遗留覆盖元数据，默认 `false`。胜出者由文件优先级决定；同名用户文件替换已安装的内置副本无需设置此字段 |
| `main` | 否 | 策展标记。为 `true` 时该 profile 可作为 main agent 候选，默认不出现在 `AgentRun` 工具的角色列表里。这不是授权门：`--agent`、`--agent-file`、MCP 和 SDK 仍可按名绑定目录中的任意 profile |
| `delegation_notice` | 否 | `auto`（默认）在该 profile 作为 subagent 或独立宿主 Agent 运行时注入按位置区分的委派说明；`off` 关闭。main agent 绑定从不注入 |
| `model_alias` | 否 | `[models]` 中区分大小写的精确 alias，或显式写 `inherit`，让 subagent 绑定调用方当前模型。未固定模型的 profile 需要派发时显式提供 `model_alias`；省略不会继承。main agent 没有调用方，不可使用 `inherit` |
| `thinking_effort` | 否 | 该 profile 作为新 subagent 启动时请求的思考强度。使用 `model_alias: inherit` 时，适用的显式档位 pin 优先于调用方的有效思考强度 |
| `executor` | 否 | `agent-executors.toml` 中的 executor id；省略时使用原生引擎。进程内派发与外部委派表面都会为具名子 Agent 使用这份绑定。外部委派中，harness 的审批请求通过该 root 的 `interactions` / `respond` 操作暴露，并且只覆盖它自己的直属子 Agent。示例 profile 位于仓库中的 `docs/examples/agent-profiles/external-harnesses/` 目录 |
| `allowed_models` | 否 | 该 role 推荐使用的模型 alias，支持 YAML 列表或逗号分隔字符串。比较走规范模型身份，因此裸 alias 与带 provider 前缀的名字可以互相匹配。只要模型存在且 executor 支持，列表外的模型仍可执行；子 Agent 会记录结构化 advisory，而不是拒绝派发。只写一项表示强推荐，不是权限边界。省略字段或写 `"*"` 表示不提供推荐；`[]` 表示没有推荐模型，但不会阻止显式、可执行的绑定。Caller lease 与 `spawn_constraints` 采用同样的软建议语义。机器级 `[subagent].deny_models` 仍然具有最终否决权 |
| `deny_models` | 否 | 该 role 建议避免的模型 alias 名单，写法与 `allowed_models` 相同。选中其中模型时会继续执行并产生醒目的结构化 advisory。需要在所有路径硬拒绝某个模型时，应使用机器级 `[subagent].deny_models` |
| `allowed_efforts` | 否 | 该 role 推荐的 thinking effort 列表。角色级与命中的 `model_profiles` 条目求交，用于推荐和诊断。只要实际档位可执行，交集外的 effort 会继续运行并产生结构化 advisory；provider 或 executor 无法执行的档位仍是硬错误 |
| `model_profiles` | 否 | 该角色在某个模型上的跑法。只支持 YAML mapping 列表。必填 `alias`；可选 `when`、`thinking_effort`、`allowed_efforts`、`prompt_mode`（`prepend` / `append` / `wrap`）、`prompt`、`prompt_overrides`、`service_tier`、`request_params`、`context_budget` 与 `max_completion_tokens`。`when` 只给派发方看，渲进 `AgentRun` 工具说明，不写进子 Agent 自己的提示词。带 `prompt_mode` 的条目在角色正文之后、模型 cognition overlay 之前组合；`wrap` 要求正文恰好一次 `${parent_prompt}`（或其别名 `${base_prompt}`）。本机 `[models]` 表解析不到的 alias 既不出现在工具说明里，也不生效。重复 alias 会全部保留在文件里，overlay 只匹配第一条解析成功的 |
| `prompt_overrides` | 否 | 该 profile 的提示词字段覆写，可含 `files` 与 `fields`。此层覆盖全局与模型值；匹配的 `model_profiles[].prompt_overrides` 条目再覆盖它。详见 [`prompt`](../configuration/config-files.md#prompt) |
| `system_prompt_mode` | 否 | 提示词正文模式：`replace`（默认）、`prepend`、`append` 或 `inherit`。`inherit` 要求正文为空且 `prompt_overrides` 非空；它保留下层同名 profile 定义，并应用本文件的字段覆写 |
| `service_tier` | 否 | Profile 默认服务档位：`auto`、`default`、`flex` 或 `priority`。配置了 `[models."<alias>"].service_tier` 时，每个请求优先采用模型的档位。目前只有 `openai_responses` 协议会把它编码进请求体，其他协议静默忽略 |
| `request_params` | 否 | 附加请求参数，标量 map（值只允许字符串 / 数字 / 布尔值），该子 Agent 的每个请求都会携带。OpenAI 系协议展开进请求体（Kimi 经 `extra_body`），不会覆盖引擎生成的字段；Anthropic 协议静默忽略；与 `service_tier` 等一等字段冲突时一等字段优先。键名原样发送，provider 可能拒绝它不认识的键。`kimi` provider 的 typed 参数（如 `temperature`、`top_p`）写在这里——只有底层模型真正支持时才传 |
| `context_budget` | 否 | 该 profile 的上下文窗口 token 上限。仅作为上限声明，不得超过所绑定模型的 `max_context_size`。生效值取所有声明层的最小值；只能缩小预算，不能放大到超过模型真实 capacity |
| `max_completion_tokens` | 否 | 单次 LLM step 的输出 token 上限。仅作为上限声明，生效值取所有声明层的最小值；与输入上限、总上下文窗口互相独立，详见[配置文件](../configuration/config-files.md#models) |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。支持 YAML 列表或逗号分隔字符串（`tools: Read, Grep`）两种写法。缺省或单独的 `*` 表示不增加 profile 白名单限制；空列表（`tools: []`）表示禁用全部工具。[subagent 默认限制](../configuration/config-files.md#subagent)及其他策略仍然生效；看板工具需要精确点名或服务端显式允许 |
| `disallowedTools` | 否 | 禁止列表，写法与匹配规则相同，在 `tools` 之后应用 |
| `disabled-tool-groups` | 否 | 内置工具组的禁止列表，YAML 列表或逗号分隔字符串，如 `disabled-tool-groups: [shell, web]`。组内每个内置工具都会被收回，除非该工具在 `tools` 中被显式点名；未知的组名会在加载时报错。同一 profile 内的优先级，从最具体开始：`disallowedTools`（被点名的工具保持禁用）> `tools`（显式列出的工具不受组禁用影响）> `disabled-tool-groups`。只有内置工具属于工具组，MCP 工具与用户工具永远不匹配。各组归属：`agent`（`AgentRun`、`AgentList`、`AgentSend`、`AgentNotify`）、`board`（`BoardRead`、`BoardWrite`）、`cron`（`CronCreate`、`CronList`、`CronDelete`）、`fsRead`（`Read`、`ReadMediaFile`、`Glob`、`Grep`）、`fsWrite`（`Write`、`Edit`）、`goal`（`CreateGoal`、`GetGoal`、`UpdateGoal`、`SetGoalBudget`）、`plan`（`EnterPlanMode`、`ExitPlanMode`、`TodoList`）、`question`（`AskUserQuestion`）、`shell`（`Bash`）、`skill`（`Skill`）、`task`（`TaskList`、`TaskOutput`、`TaskStop`、`TaskWait`）、`thread`（`ThreadList`、`ThreadRead`、`ThreadSend`、`ThreadWait`）、`toolSelect`（`SelectTools`）、`web`（`WebSearch`、`FetchURL`） |
| `subagents` | 否 | 可委派的子 Agent 名称列表，写法与 `tools` 相同（YAML 列表或逗号分隔字符串）。子 Agent 一旦声明该列表，默认严格执行：`subagents: []` 禁止所有新子 Agent 派遣，其他显式名称构成白名单；省略或单独写 `*` 表示不限制 |
| `subagent_policy` | 否 | `strict` 强制执行声明的 `subagents` 列表；`advisory` 允许派往列表外的目标，但会记录推荐偏离。profile 的显式值优先于设置默认值 |

派遣策略有两个独立默认值：`[subagent] main_dispatch_policy = "advisory"` 适用于主 Agent；`[subagent] subagent_dispatch_policy = "strict"` 适用于声明了 `subagents` 列表的子 Agent。两者均可取 `advisory` 或 `strict`，可在「设置 → Agents」修改。未声明列表的子 Agent 仍默认 advisory，不受后一个默认值影响。能力面板将目标区分为「推荐」「允许但不推荐」「明确禁止」；`AgentRun` 仅列出允许目标，并突出推荐目标。模型与思考强度的建议独立于派遣策略，仍是软约束。

`model_profiles` 是一个 YAML mapping 列表。顶层写成字符串、标量或单个 mapping 都是非法的，因为每个条目都需要 `alias`；`when` 与其他字段全部可选。示例：

```yaml
model_profiles:
  - alias: fast-model
    when: 范围与验收标准已经明确，快速给出结论比等待更划算。
    thinking_effort: high
    context_budget: 32000
    max_completion_tokens: 4096
  - alias: k3-review
    when: 默认 alias 自己就能完成的常规评审。
    prompt_mode: prepend
    prompt: |
      优先做系统级与全局契约推理。
    service_tier: priority
    request_params:
      temperature: 0.2
```

`model_profiles` 按规范模型身份匹配。先得到模型 alias 的有效配置（包括其 `overrides`），再按 "模型 alias → profile 顶层 → 命中的 `model_profiles` 条目" 合并：`request_params` 逐键覆盖，`service_tier` 使用最后一个明确值。`context_budget` 和 `max_completion_tokens` 是限制，取各层声明值的最小值，并继续受模型容量与输出上限约束；省略表示不增加限制。仅顶层 `thinking_effort` 要求当前模型匹配 profile 的默认 `model_alias`；这一条件不限制其它 profile 参数。

给单个模型补充提示词，仍用模型 cognition 通道（`[models."<alias>".cognition]`）：`model_profiles.prompt_mode` 与 `prompt` 扩的是 role 自身正文，alias cognition 扩的是模型的系统提示词——两者是不同位置，不要把 `prompt_mode` 当作模型认知开关的替代。

`allowed_models`、role `deny_models` 与 `allowed_efforts` 用来形成推荐，并在实际绑定偏离时产生 advisory；它们不会扩大或收紧机器权限边界。机器级 `[subagent].deny_models` 始终优先，即使 role 推荐了同一个 alias；route sidecar 不能声明这些 role 列表字段。

```yaml
allowed_models:
  - fast-model
  - k3-review
deny_models:
  - heavy-model
```

```yaml
# 为该 role 推荐一个 alias：
allowed_models: [fast-model]
```

把这份推荐与希望作为默认值的 `model_alias` 一起写。只声明 `allowed_models` 而不写 `model_alias` 的 profile 仍会加载并给出告警，但派发时若没有指定模型会直接 fail closed，因为推荐列表本身不会选择模型。

内置工具与用户工具按名称精确匹配（区分大小写）；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。有三种写法永远匹配不到任何工具，在 profile 生效时会给出警告：`mcp__` 模式之外使用通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）；不是完整 `mcp__<服务器>__<工具>` 形式的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具 —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建提示词时都会作为模板渲染：`${var}` 占位符替换为实时上下文值——未知变量保持原样，单独的 `$` 没有特殊含义，上下文中缺失的变量渲染为空字符串。`${parent_prompt}`（别名 `${base_prompt}`）嵌入这份文件的隐式父提示词：Agent 文件里是有效默认提示词，`SYSTEM.md` 里是内置默认，route 里是基础 profile。`${builtin_prompt}` 始终是内置默认，即使存在 `SYSTEM.md`。如果文件会替换默认提示词、但仍要保留已启用 plugin 提供的指令，请把 `${plugin_sections}` 放在希望出现这些指令的位置。可用变量见下文 SYSTEM.md 变量表。

未知字段会被忽略，新版本写的文件在旧版本上仍可读取。其他 Agent 工具的字段（如 Claude Code 的 `model`、OpenCode 的 `mode`）同样会被忽略；加上 `tools` 的逗号分隔写法和 `name` 缺省回退到文件名，Claude Code 与 OpenCode 风格的 Agent 文件一般可直接加载 —— 只含 `description` 和正文的最小文件可跨工具通用。

### 具名 profile route（实验功能）

具名 route 在现有 Agent 上增加专用运行方式，但不会创建新的权限身份。启动时在 `config.toml` 中设置 `[experimental] agent-profile-routes = true`，或设置 `KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`。

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

必填字段为 `id`、`profile`、`description` 和 `prompt_mode`。可选字段为 `whenToUse`、`model_alias`、`thinking_effort`、`service_tier`、`request_params`、`tools`、`disallowedTools`、`subagents`。与普通 Agent 文件不同，route Frontmatter 使用严格解析。未知字段、非法类型、路径 / ID / profile 不匹配、同一来源内重复 ID、互斥的模型选择器只会让该 sidecar 被跳过并产生带 code 的诊断；基础 profile 和其他 route 仍会加载。`model_profiles`、`allowed_models`、`deny_models` 等仅属于 Agent 文件的字段在这里属于未知字段，会导致该 sidecar 被跳过。Route 可以推荐默认 `model_alias`；它若偏离基础 profile 的模型指引，会显示 advisory，而不会让 route 变得不可执行。

`prompt_mode` 始终保留基础提示词：`inherit` 要求正文为空；`prepend` 与 `append` 要求正文非空且不能包含 `${parent_prompt}` / `${base_prompt}`；`wrap` 要求正文必须且只能包含一次 `${parent_prompt}` 或 `${base_prompt}`。不提供无保护的 replace 模式。

Route 若声明 `tools`、`disallowedTools` 或 `subagents`，该字段整体替换基础值；省略则继承基础。`subagents: []` 会让 route 成为叶子。调用方检查仍针对基础 role，因此 route 不能引入调用方原本不能派发的 role。需要另一个 role 身份时，应新建并 allowlist 一个基础 profile。

请求字段省略时继承基础值。`service_tier: null` 清除基础 tier，其他值直接替换；`request_params: null` 清除基础 map，传入 map 时按标量 key 覆盖。Route 声明的 `model_alias` 或 `thinking_effort` 是 route 默认值。`AgentRun` 可以显式覆盖任一值；子 Agent 仍保留该 route 身份，同时标记为 detached 并记录结构化 advisory。若没有覆盖，缺失的 route 模型，或所选 provider / executor 无法执行的 effort，仍属于硬能力错误。

启用后，`AgentRun` 会列出经调用方基础 role allowlist 过滤后的精简 route 条目。条目只包含 route ID、基础 role、描述 / 使用提示、模型与 effort 默认值、被覆盖的字段名，绝不包含提示词正文。调用时传入 `route: reviewer.ui-k3`；可以省略 `profile` 让系统推导 `reviewer`，也可以显式传入这个匹配的基础 role。Role 不匹配会产生带 code 的错误。系统不会自动排序选择或静默回退。

恢复时不会重新选择或切换 route。Journal 会保存规范基础 role、route ID、渲染后的提示词、分层工具策略、denylist、子 Agent 限制、模型 / effort 锁、service tier 与请求参数。因此，即使后来关闭 flag，或 sidecar 被修改、删除、写坏，已有 routed Agent 仍从快照恢复；这些变化只影响新派发。旧 journal 继续兼容。

新派生 subagent 的模型仍只有两个来源：工具参数 `model_alias`，或生效 profile / route / caller lease 上的 `model_alias` pin；两者都在时以派发参数为准。两者都没有时派发以 `model.not_configured` 失败，不会创建子 Agent；调用方模型和 `default_model` 都不是静默回退来源。在 profile、route、caller lease 中写 `model_alias: inherit`，或给 `AgentRun` 显式传 `model_alias: "inherit"`，才会绑定调用方当前已解析的模型。此时也会跟随调用方的有效思考强度，但工具显式 `effort`，或 profile、route、caller lease、匹配的 `model_profiles` 条目上适用的 `thinking_effort` pin 优先。选择其他模型时，effort 仍按原有顺序解析：工具显式 `effort` → 匹配的 `model_profiles` 档位 → 绑定模型与 profile pin 的 `model_alias` 为同一规范模型时的 profile `thinking_effort` → 绑定模型自身默认档位。未知的具体 alias 无论来自派发参数还是 profile pin 都会报错。

使用 `AgentRun` 恢复时，`model_alias` 与 `effort` 同时省略则保留已保存绑定。`model_alias` 解析到同一规范模型时不产生变化。仅切换 `effort` 时，新值在下次空闲运行生效，已保存模型不变。切换到不同规范模型必须传 `allow_model_change: true`，且 `effort` 同时省略时重新解析目标模型的默认档位，不沿用旧 effort。显式传 `model_alias: "inherit"` 是例外：恢复时也根据调用方*当前*绑定解析模型；若没有适用的已保存 effort pin 或显式 `effort`，则跟随调用方有效思考强度。Role 指引与已保存的 route / caller lease pin 只产生 advisory，不会阻止可运行的恢复。Provider 无法执行的显式 effort、机器级模型禁止、executor thread 绑定限制和准入一致性检查仍是硬错误。

新建子 Agent 时，省略 `model_alias` 和 `effort` 即可使用目标的默认值。`AgentRun` 按每个目标的有效 profile、lease、route 和模型指引列出推荐模型。某个 alias 出现在另一目标下，不代表它也是当前目标的推荐值，但显式、可执行的覆盖会被接受并记录诊断。把 `allowed_models` 与默认 `model_alias` 一起声明，可以发布推荐模型池；`model_profiles` 提供逐模型建议。Route 的档位覆盖（包括 `service_tier: null`）不会清除模型级档位配置。

subagent 模型治理会先解析 `[models]` alias，再按规范模型身份比较。机器级 `[subagent].deny_models` 是硬模型策略，在所有 subagent 入口拒绝名单内模型。Role `allowed_models` / `deny_models`、model-profile effort 列表、route 默认值和 caller lease pin 都属于软建议；偏离事实会保存在子 Agent 绑定中，并在父侧 `AgentRun` 结果里给出摘要。字段与校验规则见[配置参考](../configuration/config-files.md#subagent)。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。`subagents` 同样双重生效：`AgentRun` 工具的类型列表只包含允许委派的 subagent，并会在实际派发前再次强制校验；继续已有 subagent 不受此限制。权限规则仍是独立的控制层，用于决定哪些操作需要审批。
:::

自定义 Agent 作为被派发的 subagent 运行时，Kiki 会注入一段简短的委派说明：最后一条消息就是交给调用方的完整交付。独立宿主调用（MCP / SDK）用另一段说明：没有父 Agent。main agent 绑定不注入。在正文里写 `${delegation_context}` 可指定位置，否则前置。profile 上设 `delegation_notice: off`，或在 `config.toml` 写 `[agents.delegation] sub = false` / `independent = false`，即可关闭。如需替换文案，通过 [`PromptOverrides`](../configuration/config-files.md#prompt) 覆写 `delegation.sub.notice` 或 `delegation.independent.notice`。旧的 delegation `.md` 路径值不再接受；布尔 gate 与 `delegation_notice: off` 始终优先于文案覆写。

### 选择 main agent

两个 CLI flag 用于选择驱动新会话的 Agent，在 print 模式（`kiki -p`）和交互式 TUI 中均可使用：

- **`--agent <name>`**：以指定 Agent 作为 main agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。该 flag 只接受一个文件：不可重复传入，也不能与 `--agent` 同时使用。

两个 flag 都仅在新建会话时有效——都不能与 `--session`/`--continue` 组合。Agent 在会话创建时绑定，恢复会话时会自动还原已绑定的 Agent，因此恢复时不需要（也不允许）携带这些 flag。

在 print 模式下，显式 `--model` 优先于所选 profile 的 `model_alias`。省略 `--model` 时，引擎先使用 profile 的模型 pin，仅在 profile 未指定模型时使用 `default_model`。因此，钉死模型的 profile 无需全局默认模型也能运行；与 main agent 不同，subagent 从不回退到 `default_model`。main agent 没有调用方，即使设置了 `default_model` 或 `--model`，其 profile 也不能固定 `model_alias: inherit`。

例如：

```sh
kiki --agent reviewer
kiki -p --agent reviewer "审查这个分支上的改动"
```

这些 CLI flag 选择启动会话的 profile，不用于修改恢复中的会话。GUI 可以在提交下一条消息时请求切换主档，但仍需通过当前绑定的约束校验。在同一 TUI 进程内后续新建的会话（例如通过 `/new`）使用默认 Agent。

定制 main agent 时，在正文中引用 `${parent_prompt}` 或 `${base_prompt}` 可保持有效默认提示词中已有的环境、工作区指令、Skill 和 plugin 注入生效。`${builtin_prompt}` 始终是出厂默认提示词，即使存在 `SYSTEM.md`。如果要替换默认提示词、但只保留 plugin 提供的指令，请改用 `${plugin_sections}`。正文同时不引用 `${parent_prompt}` / `${base_prompt}` 和 `${plugin_sections}` 时，会完全拥有自己的提示词并排除 plugin 指令，适合自包含的 subagent。

### 用 SYSTEM.md 覆盖 main agent 的系统提示词

希望永久覆盖默认 main agent、而不必每次启动都传入 `--agent` 或 `--agent-file` 时，可以写一份 `$KIKI_HOME/SYSTEM.md`（默认：`~/.kiki/SYSTEM.md`，随 `KIKI_HOME` 移动）。文件缺失或为空时不生效。读取或解析失败会产生带路径的诊断；若当前进程曾成功加载该文件，则保留它最后一次有效的 profile，其他 Agent 文件仍正常重载。开头为 `---` 的文件出现 YAML 语法错误时，绝不会被重新解释为遗留提示词。修复文件可替换保留的版本，删除文件则移除覆盖；没有历史有效版本时，跳过这份非法覆盖。SYSTEM.md 在包括交互式 TUI 会话在内的所有启动方式下生效。

解析方式看文件第一行：

- **遗留正文。** 文件并非以 `---` 加 YAML mapping 开头。只替换提示词；描述、工具集与允许委派的 subagent 列表仍沿用内置默认。不需要也不读取 Frontmatter。
- **普通 profile。** 文件以 `---` 开头，且围栏解析为 YAML mapping。按名为 `agent` 的普通 Agent 文件加载，`override` 强制为 `true`。未声明的 `tools` / `disallowedTools` / `subagents` 仍沿用内置默认；声明了的字段生效。

优先级上，显式意图仍然胜出：项目作用域中声明了 `override: true` 的同名 Agent 文件、通过 `--agent-file` 传入的文件都排在 SYSTEM.md 之前，用 `--agent` 选择其他 Agent 时 SYSTEM.md 也不会生效；而在用户作用域内部，SYSTEM.md 优先于 `agents/` 目录中扫描到的同名文件。

升级后的 `SYSTEM.md` 可以在 Frontmatter 中声明 `prompt_overrides`。设为 `system_prompt_mode: inherit` 时保持正文为空，Kiki 会保留内置 `agent` 提示词，仅应用这些字段。遗留正文或升级后的替换正文仍具有权威性，会遮蔽内置 `system.*` 段落覆写；`system.shared` 和适用的 delegation notice 仍位于正文外层。完整格式和优先级见 [`prompt`](../configuration/config-files.md#prompt)。

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
| `${parent_prompt}` | 这份文件的隐式父提示词，与 `${base_prompt}` 同一槽 |
| `${base_prompt}` | `${parent_prompt}` 的别名。在 `SYSTEM.md` 中指内置默认提示词；在 Agent 文件中指有效默认提示词（内置默认，或存在时为你的 `SYSTEM.md` 覆盖）；在 route 中指基础 profile |
| `${builtin_prompt}` | 内置默认 main 提示词，忽略 `SYSTEM.md` |
| `${delegation_context}` | 按运行位置注入的委派说明；main agent 为空 |
| `${plugin_sections}` | 已启用 plugin 提供的完整 Plugin Instructions 块；没有已启用 plugin 提供指令时为空 |

未知变量原样保留，单独的 `$` 没有特殊含义；上下文中缺失的变量渲染为空字符串。另有四个预组合块——`${windows_notes}`、`${additional_dirs_section}`、`${skills_section}`、`${plugin_sections}`——渲染对应的内置提示词段落，不适用时为空字符串。内置默认提示词已经包含 `${plugin_sections}`；当 `${base_prompt}` 已展开为该提示词时，不要再重复加入此变量。利用这些变量可以重建内置提示词的骨架，例如：

```markdown
You are Kiki, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## 指令文件

Kiki 会同时注入 `$KIKI_HOME/AGENTS.md`（默认：`~/.kiki/AGENTS.md`）与工作区根目录的 `AGENTS.md`。如果工作区根目录存在 `.kiki/AGENTS.md`，该文件会替代用户级文件，工作区根目录的 `AGENTS.md` 仍然生效。文件名匹配不区分大小写。嵌套目录、工作区根目录上方、`~/.agents/AGENTS.md` 和旧的 `.kimi-code/AGENTS.md` 路径都不会被发现。

## 会话目录中的存储位置

subagent 的运行状态持久化到当前会话目录的 `agents/` 子目录下，每个 subagent 实例对应一个独立目录，其中包含按时间顺序记录提示词、消息历史与最终状态的 `wire.jsonl` 文件。后台 subagent 还会通过 `tasks/` 子目录暴露生命周期状态。

::: warning 注意
会话目录、wire 文件和任务记录都属于本地调试材料，可能包含用户 prompt、命令输出、仓库路径、工具返回内容或凭证痕迹。不要把这些文件直接提交到公开仓库、issue 或聊天记录里；如确需分享，请先脱敏。
:::

## 下一步

- [Hooks](./hooks.md) — 在 subagent 完成等关键节点触发本地脚本通知或拦截
- [Agent Skills](./skills.md) — 给 subagent 注入专业知识和工作流程
