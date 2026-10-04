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

默认的 v2 引擎（Kiki 桌面端和 `kiki` CLI/TUI）会给主 `agent` profile 提供三个子 Agent 工具，不需要实验开关：`AgentRun`、`AgentList` 和 `AgentSend`。内置 subagent profile 没有它们。每个调用方只能列出和发消息给自己直接创建的子 Agent；孙级或别人创建的子 Agent 都不是有效目标。

`AgentRun` 用来启动新的子 Agent，或继续已有的。每次调用都必须提供 `prompt` 和用于界面展示、长度为 3–5 个词的短 `description`。新派生还可以设置 `profile`（省略时，显式配置的 `[subagent].default_profile` 会选择对应 profile；该配置键不存在时使用内建通用 subagent 提示词；显式留空时必须指定目标）、`profile_file`（显式 subagent role Markdown 文件，绝对路径或工作区相对路径；它是 role 定义而非共享提示词模板，并且与 `profile`、`route`、`resume` 互斥）、`route`、`name`、`background`、`model_alias` 和 `effort`。`allow_model_change` 仅在 `resume` 同时显式传入 `model_alias` 时有意义；该 alias 解析到不同规范模型时必须传入它。预计之后还要再找同一个子 Agent 时传入 `name`；名称必须匹配 `^[a-z0-9_]+$`，不能是 `root`，并且在会话内保持唯一。继续直属子 Agent 时，把 `resume` 设为它的名称或 agent id；它与 `name`、`profile`、`profile_file` 和 `route` 互斥。省略 `effort` 会保留已保存的 effort，也可以传入让下一次空闲运行使用。省略 `model_alias` 会保留已保存的模型；切换到不同规范模型必须传 `allow_model_change: true`，而解析到同一规范模型则不产生变化。字面标明的 `preferred_models`、`discouraged_models`、`preferred_efforts` 与 route / caller lease pin 属于软建议：满足硬规则且可执行的覆盖会继续并产生结构化 advisory。`allowed_models`、`deny_models`、`allowed_efforts` 在所有作用域都是硬规则，违规即拒绝。机器级 `[subagent].deny_models`、缺失或不受支持的模型能力、route 身份、换模确认，以及 executor / thread 限制仍是硬错误。外部 executor 不支持修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。新派生项按此顺序选模型：具体 `model_alias` 参数 → 生效 profile / route / caller lease pin → 显式配置的 `[subagent].default_model`。这些来源都不存在时以 `model.not_configured` 失败，不会创建子 Agent。effort 独立解析：工具 `effort` → 匹配的 `model_profiles` 档位 → 所绑定模型与 profile pin 匹配（按规范身份比较）时的 profile `thinking_effort` → 所绑定模型自身的默认档位。显式传入未知 `model_alias` 时会报错。省略 `background` 时，调用方是 main 则默认后台，是 subagent 则默认前台等待。显式 `true` 始终选择后台，显式 `false` 始终选择同步等待；`resume` 与 goal mode 同样按调用方应用此规则。Agent 任务默认 2 小时超时，通过 `[subagent] timeout_ms` 或 `KIKI_SUBAGENT_TIMEOUT_MS` 配置全局限制（`0` 表示禁用），print 模式默认无超时；不提供单次调用 timeout 或任意供应商参数透传。

后台派发要求 `TaskList`、`TaskOutput`、`TaskStop` 可用。关闭这些工具后，main 省略 `background` 会在启动前被拒绝，不会改为前台；请启用工具，或为真正的同轮依赖显式设置 `background:false`。Main 前台等待期间，steer / Send now 会把子 Agent 转入后台而不取消它，让下一安全步骤读取新输入；完成后仍自动通知父 Agent。普通排队消息不会释放等待。Main 轮次停止不会自动取消已脱离等待的子 Agent；请用 `TaskStop` 显式停止子任务。Subagent 必须解决自己的依赖后再交最终回执。详见 [`AgentRun` 工具参考](../reference/tools.md#协作类)。

`AgentRun` 选模时，`restrict_models_to_menu` 关闭（默认）意味着 profile 菜单不是穷举；开启后，仅作者原始默认 `model_alias` 与 `model_profiles` 菜单条目可选，且仍须满足所有其他硬规则与执行能力。Route / caller lease pin 和显式 `model_alias` 参数不能增加候选。菜单外选择被拒绝，不回落；`resume` 和 `allow_model_change: true` 也不扩充冻结菜单。详见 [模型菜单与硬边界](./agent-profiles.md#模型菜单与硬边界)。

`profile_file` 直接提供角色定义，无需注册成预设，也不按文件中的名字套用预设 allow / deny 名单。`allowed_subagents: []` 仍允许这条路径；`can_spawn_subagents: false` 禁止新建全部子 Agent。路径可为绝对路径或工作区相对路径，解析链接后的真实路径仍须位于允许的目录内。

`AgentList` 返回这些直属子 Agent。默认 `include_finished=false` 列出运行中的，以及没有跟踪任务的；需要已经结束或失败的，再传 `true`。最多返回 50 条，运行中的排在前面。

`AgentSend` 把消息排进邮箱，投递语义是尽早送达：子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn；空闲且可恢复的子 Agent 会以该消息启动一次新的运行，其完成同样触发父 Agent 的完成通知。用 `name` 或 agent id 指定目标。

`AgentNotify` 方向相反，且只有 subagent 可用：它把一条 fire-and-forget 消息排进父 Agent 的邮箱，父 Agent 正在运行时会在下一个 step 边界注入其活跃 turn，空闲时则在下一次运行时读取。Main agent 没有父 Agent，永远不会拿到这个工具。在 `config.toml` 中设置 `[agents] notify_parent = false` 可以全局关闭它，默认开启。

## Peer thread 通信

Peer thread 通信让主 Agent 协调同一台本地主机上的现有 Kiki 会话，也可以跨工作区通信。它与上面的子 Agent 工具相互独立，并且默认关闭。选择启用后，`ThreadList`、`ThreadRead`、`ThreadSend` 和 `ThreadWait` 这 4 个工具提供给会话的主 Agent。子 Agent 默认拿不到这几个工具；在其 profile 的 `tools` 名单中点名 `ThreadList`、`ThreadRead`、`ThreadWait` 即可开放，而 `ThreadSend` 仍仅供主 Agent 使用，因为它以父会话的 peer 身份发送。主 Agent 若要创建独立会话，可直接调用 [`ThreadCreate`](../reference/tools.md#协作类)，无需启用 peer thread 通信。

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

### Profile 热刷新与进行中的会话

agent 文件会被监听并在变更时热刷新。热刷新不会打断进行中的会话：已在运行或恢复的 agent 继续使用其绑定时的提示词与约束快照，哪怕对应 profile 被编辑、设为 `private`、删除或失效。冻结的派遣列表会跳过失效目标，而不是让整段对话失败。变更只对**新的**派遣生效——向私有或已删除 profile 发起新派遣会得到明确报错。恢复缺少可恢复绑定快照且 profile 已不存在的旧记录时，降级到默认 profile 并给出警告；模型、effort 与执行器仍会被校验。

### 外部 ACP profile 的投递

对于对外派发使用的 ACP（Agent Client Protocol）执行器，只有配置表明 harness 支持 `session/new` 的 `_meta.systemPromptOverride` 扩展，Kiki 才会把冻结的 profile 作为系统提示词发送。内置 `grok-acp` 执行器默认启用；其他 ACP 执行器仍把 profile 放在第一条 User 消息的前言里。若自定义 harness 支持该扩展，可在 `config.toml` 的 `[agent_executors.<id>]` 中设置 `profile_delivery = "system_prompt_override"`。若 harness 会忽略该扩展，不要启用：配置后 Kiki 不再附加 User 消息前言作为后备。

覆写只在创建**新的远端会话**时生效，不会在 `session/resume` 或 `session/load` 时重新发送。已有的远端会话保留最初的 profile 投递方式，即使之后更改执行器配置也一样。使用已变更的冻结 profile 重新派发会创建新的远端会话；若远端恢复失败，Kiki 会新建会话，重新发送覆写并附上有长度限制的对话交接。该设置不会发送 `_meta.rules` 或 `_meta.agentProfile`。系统提示词覆写可能替换 harness 原有的默认系统提示词，因此只应对适合这种替换方式的 harness 启用。

内置 `kimi-acp` 执行器会把已配置的 MCP 服务器转发给 Kimi Code。`0.37.0` 至 `0.39.0` 之前的 Kimi CLI 不接受 ACP stdio MCP 服务器；预检会警告 MCP 工具将失败，并建议升级到 `0.39.0` 或更高。警告不会阻止转发。若无法探测版本号，Kiki 仍转发服务器，不发出这条版本警告。

### 外部 main agent 的委派

外部执行器可以担任 main agent。若要让它派遣 Kiki subagent，请在其 profile 中添加 `allow_kiki_subagents: true`，并把该 profile 绑定到 main agent。该字段默认是 `false`，不会开启外部子 Agent 的委派能力。

Kiki 把 MCP 工具（harness 调用 Kiki 的桥）附加到**已有会话**，不会另建 seat 会话。harness 必须支持本机 stdio MCP，即通过进程输入输出调用工具；其进程也必须能找到 `kiki`。profile 的派发开关、预设权限与推荐、模型约束和父级通知策略仍然生效。修改开关后需重新绑定 main profile；已有绑定保留冻结快照。在已绑定的 main profile 上关闭委派，或关闭执行器，都会撤销桥的权限。

子 Agent 完成后，回执会非阻塞地排入同一 main agent 的收件队列。main agent 忙碌时，等待当前轮次结束再投递；空闲时，队列回执会唤醒它。父级通知也使用同一段对话，仍受 `allow_parent_notify` 和配置的通知策略约束。

Codex app-server 的 MCP 工具调用可能另需厂商审批，Kiki 会将其映射为持久化审批交互。manual 或 auto 模式（`on-request`）允许你回答。Full access（YOLO）仅在 Codex 层预批准附加的 `kiki-harness` MCP server，其调用仍受 Kiki 自身的能力和执行策略约束。其他 MCP server 保留原审批策略，workspace-write 沙箱不会被扩大。

外部交互取决于 harness 握手声明的能力。ACP 历史 fork 在支持时使用 `session/fork`；精确定位到 Assistant 消息还需要 Claude、Codex 或 DeepSeek adapter 支持的 AIR fork 定点扩展。不支持的位置会新建远端会话并附上有长度限制的对话交接，绝不会继续源远端会话。Codex 与 DeepSeek 的 ACP 表单问题映射到 Kiki 持久化问题交互；不支持的复杂表单和 URL 模式请求会被拒绝。Grok 的计划审批映射到持久化计划审阅交互。这些映射不会把 harness 本身不支持的功能变成原生能力。

### 外部 main agent 的 Kiki 上下文

在外部 main profile 中配置 `kiki_context`，即可独立于委派开关开启 Kiki 原生上下文工具：

```yaml
executor: claude-acp
allow_kiki_subagents: true
kiki_context: [memory, board, cron, threads, history, hooks]
```

列表默认不设置（所有上下文组关闭），`[]` 表示显式全部关闭。修改后需要重新绑定 main profile。桥启动时一次性注册工具；开启工具组不会改写正在运行的 harness 工具列表。profile 的原生工具策略与功能设置仍然生效，被禁用的原生工具不会暴露。只有外部 main agent 可以取得这个桥。

| 工具组 | MCP 工具 |
| --- | --- |
| `memory` | `kiki_memory_read`、`kiki_memory_search`、`kiki_memory_write` |
| `board` | `kiki_board_read`、`kiki_board_write` |
| `cron` | `kiki_cron`（`action: create`、`list` 或 `delete`） |
| `threads` | `kiki_thread_list`、`kiki_thread_read`、`kiki_thread_send` |
| `history` | `kiki_history_search`、`kiki_history_read` |
| `hooks` | 消息上下文注入，不增加模型可调用的工具 |

这些工具沿用 Kiki 原生参数和执行策略，包括审批、persona 可见性、工作区访问、记忆候选审核和 Plan 模式限制。调用归属到已有 main agent，不会变成用户写入，也不会新建 seat 会话。桥的 token 不能访问普通 REST 端点或选择另一调用方会话。原生读取工具声明 MCP 只读标记。厂商审批与 Kiki 审批是独立层；上述 Codex Full access 的预批准例外仍适用。

`hooks` 通过消息发送记忆摘要和尚未送达的提醒、工作笔记，不改写系统提示词或工具 schema。在桥的生命周期内，相同内容不会重复注入。Kiki 时间线使用 `hook_result` 来源记录 hook 内容。Kiki 只创建临时进程或会话配置，不编辑 harness 自己的全局 hook 设置。

| Harness | 注入方式 |
| --- | --- |
| Claude ACP | 通过 `session/new` 元数据传入临时命令 hook settings；`SessionStart` 与 `UserPromptSubmit` 使用 `additionalContext`。 |
| Codex app-server / ACP | 临时 `hooks.json` 定义转为进程或会话配置，仅固定信任这些命令；`SessionStart` 与 `UserPromptSubmit` 使用 `additionalContext`。 |
| Antigravity | 隔离的 `GEMINI_HOME` 中配置 `PreInvocation.injectSteps`；ACP 是否读取 hook、隔离目录能否保留登录，尚未通过可运行的 ACP server 验证。 |
| Grok ACP | 原生会话级 ACP `Stop` 回调注入 `additionalContext`，不依赖 plugin hook 的激活。session-start 和 prompt-submit hook 不能注入上下文，因此 Kiki 保留工具执行前已有的消息前缀。 |

Claude 和 Codex 的 `PreCompact` hook 会准备可追踪的交接快照，但不接受 `additionalContext`，Kiki 不会把快照标记为已注入。Claude 压缩后的 `SessionStart`，或 Codex 准备事件之后的下一次 `UserPromptSubmit`，会恢复状态摘要。Antigravity 和 Grok 没有已验证的压缩前注入事件。这些 hook 不会补出 harness 的空闲唤醒能力。

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
Agent 文件属于提示词配置，而项目级文件来自仓库本身 —— 包括你刚刚 clone、尚不可信的仓库。项目作用域的文件可以完全接管内置 Agent：名为 `agent.md` 的文件可以替换**默认 main agent 的整个系统提示词**，`general.md` 可以替换默认 subagent 类型，无需声明 `override: true`。与 `AGENTS.md` 内容（从属于系统策略与当前用户请求的作用域指令）不同，override 文件**就是**系统提示词本身；不写 `tools` 表示不在适用的运行时策略之外增加 profile 白名单限制。在不熟悉的仓库中运行 Kiki 之前，请以对待脚本同样的谨慎检查其中的 `.kiki/agents/` 与 `.agents/agents/` 目录。
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

下表中模型列表的拒绝与 advisory 行为针对 **subagent 绑定**。会话的 main agent 以用户选择为准：profile 模型与档位硬规则违规只警示，推荐与默认 pin 的偏离不警告、不拒发。通过 `AgentRun` 使用 `main: true` profile，仍按 subagent 规则执行。详见 [模型菜单与硬边界](./agent-profiles.md#模型菜单与硬边界)。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 由小写字母和数字组成，以单个连字符或下划线分隔的唯一标识（如 `code-reviewer`、`code_reviewer`）。缺省时取去掉扩展名的文件名（如 `review.md` → `review`）；无效文件会被跳过并告警，选择同名的跳过文件时会显示路径和原因 |
| `description` | 是 | Agent 的用途。main agent 挑选 subagent 时会看到，请围绕委派决策来写 |
| `whenToUse` | 否 | 补充说明何时应使用该 Agent |
| `override` | 否 | 遗留覆盖元数据，默认 `false`。胜出者由文件优先级决定；同名用户文件替换已安装的内置副本无需设置此字段 |
| `main` | 否 | 策展标记。为 `true` 时该 profile 可作为 main agent 候选：它不出现在 `AgentRun` 的角色列表、推荐排序和默认选择中。这不是授权门——显式传入 `profile` 名，或用 frontmatter 声明 `main: true` 的 `profile_file`，仍会把它当作 subagent 派遣，其模型、工具与权限按普通 subagent 解析（它不会成为会话的 main agent）；回执会附带一次 `main_profile_notice`，提示长期协作或用户可见会话更适合用 `ThreadCreate`。`--agent`、`--agent-file`、MCP 和 SDK 仍可按名绑定目录中的任意 profile |
| `delegation_notice` | 否 | `auto`（默认）在该 profile 作为 subagent 或独立宿主 Agent 运行时注入按位置区分的委派说明；`off` 关闭。main agent 绑定从不注入 |
| `permission_mode` | 否 | 该 profile 的权限模式：`manual`、`auto`、`review` 或 `yolo`。profile 启动新 Agent 时会覆盖 `default_permission_mode`；显式 CLI 参数 `--permission-mode` 优先级更高。 |
| `model_alias` | 否 | `[models]` 中区分大小写的精确 alias，或在配置中写 `inherit`，让 subagent 绑定调用方模型。无 pin 时使用具体派发参数或显式 `[subagent].default_model`；省略从不继承调用方。Pin 是软默认值，不能绕过硬列表。main agent 没有调用方，不可使用 `inherit` |
| `restrict_models_to_menu` | 否 | 布尔值，默认 `false`，仅放 profile 顶层。`true` 从作者原始默认 `model_alias` 与 `model_profiles[].alias` 派生一道**硬**模型上限，在 route / lease 改写前捕获并随绑定冻结。其他硬允许域继续求交，禁止项仍生效；显式 pin 与恢复不能绕过。见 [模型菜单与硬边界](./agent-profiles.md#模型菜单与硬边界) |
| `thinking_effort` | 否 | 该 profile 作为新 subagent 启动时请求的思考强度。使用 `model_alias: inherit` 时，适用的显式档位 pin 优先于调用方的有效思考强度 |
| `executor` | 否 | `agent-executors.toml` 中的 executor id；省略时使用原生引擎。进程内派发与外部委派表面都会为具名子 Agent 使用这份绑定。外部委派中，harness 的审批请求通过该 root 的 `interactions` / `respond` 操作暴露，并且只覆盖它自己的直属子 Agent。示例 profile 位于仓库中的 `docs/examples/agent-profiles/external-harnesses/` 目录 |
| `allow_kiki_subagents` | 否 | 默认 `false`。该 profile 绑定到外部 main agent 时附加 Kiki 的同会话委派工具；需要本机 stdio MCP。见 [外部 main agent 的委派](#外部-main-agent-的委派) |
| `kiki_context` | 否 | 按需开启 `memory`、`board`、`cron`、`threads`、`history`、`hooks` 的列表；不设置或 `[]` 表示全部关闭。见 [外部 main agent 的 Kiki 上下文](#外部-main-agent-的-kiki-上下文) |
| `allowed_models` | 否 | **硬**模型允许列表，支持 YAML 列表或逗号分隔字符串。原生 alias 按规范模型身份比较；外部 executor 按其实际生效模型 ID 检查。列表外绑定会被拒绝，包括显式 pin、人工选择与恢复。`[]` 不允许任何模型；省略、`null` 或单独的 `"*"` 表示不增加限制。不得将 `*` 与名称混写 |
| `deny_models` | 否 | **硬**模型禁止列表。命中即拒绝，即使另一列表允许它。为空或省略表示无禁止项；不接受通配符。机器级 `[subagent].deny_models` 仍是额外硬边界 |
| `allowed_efforts` | 否 | **硬**有效思考强度允许列表。Profile、lease、树策略与匹配的 model-profile 规则同时生效；`[]` 不允许任何档位。显式 pin 与宿主 forced 值均不能绕过。Provider / executor 不支持的档位仍是错误 |
| `preferred_models` | 否 | **软**模型推荐。选另一个可执行且满足硬规则的模型时继续运行，并记录结构化 `model_not_preferred` advisory（提示性诊断）。不会自动选择模型 |
| `discouraged_models` | 否 | **软**的不建议模型。选中时继续执行并记录 `model_discouraged` advisory；需要拒绝时用 `deny_models` |
| `preferred_efforts` | 否 | **软**档位推荐。偏离时继续执行并记录 `effort_not_preferred` advisory；需要拒绝时用 `allowed_efforts` |
| `model_profiles` | 否 | 按模型定义跑法，只支持 YAML mapping 列表。必填 `alias`；可选 `when`、`thinking_effort`、上述六个硬 / 软模型列表字段、`prompt_mode`（`prepend` / `append` / `wrap`）、`prompt`、`prompt_overrides`、`service_tier`、`request_params`、`context_budget`、`auto_compact` 与 `max_completion_tokens`。`when` 只出现在派发方工具说明里。Prompt 增量在模型 cognition 之前与角色正文组合；`wrap` 要求 `${parent_prompt}` 或 `${base_prompt}` 恰好一次。原生模型解析不到的 alias 不生效，也不出现在工具说明里。默认值取首个匹配条目；所有匹配条目的硬列表均生效，包括默认值已被 lease 替换的原条目 |
| `prompt_overrides` | 否 | 该 profile 的提示词字段覆写，可含 `files` 与 `fields`。此层覆盖全局与模型值；匹配的 `model_profiles[].prompt_overrides` 条目再覆盖它。详见 [`prompt`](../configuration/config-files.md#prompt) |
| `system_prompt_mode` | 否 | 提示词正文模式：`replace`（默认）、`prepend`、`append` 或 `inherit`。`inherit` 要求正文为空且 `prompt_overrides` 非空；它保留下层同名 profile 定义，并应用本文件的字段覆写 |
| `service_tier` | 否 | Profile 默认服务档位：`auto`、`default`、`flex` 或 `priority`。配置了 `[models."<alias>"].service_tier` 时，每个请求优先采用模型的档位。目前只有 `openai_responses` 协议会把它编码进请求体，其他协议静默忽略 |
| `request_params` | 否 | 附加请求参数，标量 map（值只允许字符串 / 数字 / 布尔值），该子 Agent 的每个请求都会携带。OpenAI 系协议展开进请求体（Kimi 经 `extra_body`），不会覆盖引擎生成的字段；Anthropic 协议静默忽略；与 `service_tier` 等一等字段冲突时一等字段优先。键名原样发送，provider 可能拒绝它不认识的键。`kimi` provider 的 typed 参数（如 `temperature`、`top_p`）写在这里——只有底层模型真正支持时才传 |
| `context_budget` | 否 | 该 profile 的上下文窗口 token 上限。仅作为上限声明，不得超过所绑定模型的 `max_context_size`。生效值取所有声明层的最小值；只能缩小预算，不能放大到超过模型真实 capacity |
| `auto_compact` | 否 | 自动压缩点，写正整数 token；匹配的 `model_profiles` 条目也可单独设置。优先于模型和全局默认值，但不会覆盖该 Agent 按模型保存的会话覆写。这是软目标，不是窗口上限 |
| `max_completion_tokens` | 否 | 单次 LLM step 的输出 token 上限。仅作为上限声明，生效值取所有声明层的最小值；与输入上限、总上下文窗口互相独立，详见[配置文件](../configuration/config-files.md#models) |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。支持 YAML 列表或逗号分隔字符串（`tools: Read, Grep`）两种写法。缺省、单独的 `*`、以及 `*` 与具体名字并列表，都不增加 profile 白名单限制；空列表（`tools: []`）表示禁用全部工具。[subagent 默认限制](../configuration/config-files.md#subagent)及其他策略仍然生效：点名某个工具，就是为该档案作为子智能体时显式开放它，因此 `tools: ["*", ThreadRead]` 保留普通工具并额外加入 `ThreadRead`，而只写 `*` 不会开放任何 opt-in；有限名单仍然有限。服务端 `subagent.allowed_tools` 点名的工具，只有在本名单也选中它时才对该档案开放，因此写了有限 `tools` 名单的档案会挡住自己没列出的工具；没写名单（或写了 `*`）的档案，则对该项开放到的工具都是开放的。`disallowedTools` 仍能禁用这两处开放中的任意一个 |
| `disallowedTools` | 否 | 禁止列表，写法与匹配规则相同，在 `tools` 之后应用 |
| `disabled-tool-groups` | 否 | 内置工具组的禁止列表，YAML 列表或逗号分隔字符串，如 `disabled-tool-groups: [shell, web]`。组内每个内置工具都会被收回，除非该工具在 `tools` 中被显式点名；未知的组名会在加载时报错。同一 profile 内的优先级，从最具体开始：`disallowedTools`（被点名的工具保持禁用）> `tools`（显式列出的工具不受组禁用影响）> `disabled-tool-groups`。只有内置工具属于工具组，MCP 工具与用户工具永远不匹配。各组归属：`agent`（`AgentRun`、`AgentList`、`AgentSend`、`AgentNotify`）、`board`（`BoardRead`、`BoardWrite`）、`cron`（`Cron`；旧名 `CronCreate`、`CronList`、`CronDelete`）、`fsRead`（`Read`、`ReadMediaFile`、`Glob`、`Grep`）、`fsWrite`（`Write`、`Edit`）、`goal`（`Goal`；旧名 `CreateGoal`、`GetGoal`、`UpdateGoal`、`SetGoalBudget`）、`plan`（`EnterPlanMode`、`ExitPlanMode`、`TodoList`）、`question`（`AskUserQuestion`）、`shell`（`Bash`）、`skill`（`Skill`）、`task`（`TaskList`、`TaskOutput`、`TaskStop`、`TaskWait`）、`thread`（`ThreadCreate`、`ThreadList`、`ThreadRead`、`ThreadSend`、`ThreadWait`）、`toolSelect`（`SelectTools`、`CallTool`）、`web`（`WebSearch`、`FetchURL`） |
| `can_spawn_subagents` | 否 | `false` 禁止新建所有子 Agent，包括 `profile_file`；不禁止恢复已有子 Agent。省略或 `null` 表示本层不额外关闭；`true` 不能重新打开基础 profile 或 lease 中的 `false` |
| `allowed_subagents` | 否 | **硬**预设 profile 名单，包含 route 的基础 profile 与作用域别名。支持 YAML 列表、逗号字符串或 name / lease / source mapping。`[]` 不允许预设角色，但仍可显式提供 Markdown 定义。省略、`null` 或包含 `"*"` 表示本层不增加预设限制 |
| `preferred_subagents` | 否 | **软**预设推荐。其他可见且满足硬规则的预设仍可派发，并记录 advisory（提示性诊断）。不授予权限、不选择默认、不触发回退；`[]` 清空推荐 |
| `deny_subagents` | 否 | **硬**预设禁止项，即使另一列表允许也会拒绝。`"*"` 禁止全部预设，不禁止显式 Markdown 定义。空列表或省略表示无禁止项 |
| `spawn_constraints` | 否 | 后代继承的规则：`allowed_models`、`deny_models`、`allowed_efforts`、`disallowed_tools` 是硬规则；`preferred_models`、`discouraged_models`、`preferred_efforts` 是软建议。允许集合沿树求交，禁止项累积；pin 不得放宽硬规则 |
| `private` | 否 | 在派遣与选择列表（`AgentRun`、设置页选择器）中隐藏该 profile。私有 profile 仍然注册在案：已在运行或恢复的 agent 继续按绑定快照工作，而**新的**派遣会以"profile is private"明确报错。用于下线某个角色而不打断进行中的会话 |

只想推荐角色时，写 `preferred_subagents: [explore]`，不要写封闭名单。预设权限、推荐与模型 / 工具规则相互独立。基础 profile、route 与 caller lease 叠加时，允许集合求交、禁止项累积、`false` 保持关闭；最近一层显式推荐列表替换较早的推荐。`"*"` 可以与名字和 source / lease mapping 同列：本层保持开放，mapping 仍生效。重复的裸名字会忽略；同一别名的两份不同 mapping 会报错。

`profile_file` 直接提供新的角色定义，无需注册进预设目录。文件里的 `name` 不会使它变成同名预设：预设 allow / deny 名单及同名 caller lease 不适用，调用方的可选预设名单也不会复制成该文件子 Agent 自己的下游规则。文件自己的规则、继承的模型 / 工具限制与工作区路径检查仍然生效。完全叶子角色请写 `can_spawn_subagents: false`，不要用 `allowed_subagents: []` 代替。

**迁移：**作者字段 `subagents`、`subagent_policy`，以及宿主设置 `main_dispatch_policy`、`subagent_dispatch_policy` 已移除。仅用于建议的角色名移至 `preferred_subagents`；真正的预设边界移至 `allowed_subagents` / `deny_subagents`；原叶子角色使用 `can_spawn_subagents: false`。Source 与 lease mapping 保留在 `allowed_subagents` 下。已保存绑定会升级，不改选角色、模型、提示词或来源快照。结构化编辑保留未传字段；`null` 删除本地声明，`[]` 写入显式空列表。

`model_profiles` 是一个 YAML mapping 列表。顶层写成字符串、标量或单个 mapping 都是非法的，因为每个条目都需要 `alias`；`when` 与其他字段全部可选。命中条目的 `auto_compact` 优先于 profile 顶层值；两处都只写整数 token，不接受百分比。示例：

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

Subagent 绑定中，`allowed_models`、`deny_models`、`allowed_efforts` 在所有作用域都是硬约束：profile、`spawn_constraints`、caller lease 与匹配的 `model_profiles` 条目。允许集合求交，禁止项累积。违规返回 `profile.constraint_violation`，包含规则来源、允许 / 禁止值、有效值与绑定值来源。Advisory 角色派遣、显式 pin、人工切换模型 / 档位与恢复都不能放宽它们。机器级 `[subagent].deny_models` 增加另一道硬边界；route sidecar 不能声明模型硬列表字段。外部 executor 完成规范化后，还会按其实际生效模型 ID 再检查。

```yaml
model_alias: fast-model
allowed_models: [fast-model, review-model]
deny_models: [heavy-model]
allowed_efforts: [high, max]
preferred_models: [fast-model]
preferred_efforts: [high]
discouraged_models: [review-model]
```

这里 `review-model` 仍可执行，但携带 advisory；`heavy-model` 被拒绝。列表本身不选择模型：使用 `model_alias` pin、派发参数或显式配置的 `[subagent].default_model`。

若默认模型与逐模型跑法已经组成完整获准菜单，优先让菜单成为契约，而不是维护重复的正向硬列表：

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: 需要更深入的评审。
    thinking_effort: high
preferred_models: [fast-model]
```

这份配置允许原始默认 `fast-model` 与菜单条目 `review-model`，不允许任意显式覆盖；其他硬规则还可进一步收紧。只做推荐的菜单继续关闭开关，使用 `preferred_*` / `discouraged_models`；独立预算、合规、部署或下级树边界使用 `allowed_models` / `deny_models`。开关默认关闭，不会自动迁移已有 profile。三场景选择规则见 [何时开启](./agent-profiles.md#何时开启)。

**迁移：**既有 `allowed_models`、`deny_models`、`allowed_efforts` 立即按字面硬语义执行，没有旧字段软模式。只用于建议的列表，应在各受影响作用域分别改名为 `preferred_models`、`discouraged_models`、`preferred_efforts`。真正的硬边界保持不变，仅为明确允许的备选绑定放宽列表。保留 `model_profiles` 候选与默认 pin；只迁移其中确属建议的字段，不替换该机制。已保存绑定超出硬规则时恢复会被拒绝：先选择许可值或修正规则，再重试。

内置工具与用户工具按名称精确匹配（区分大小写）；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。有三种写法永远匹配不到任何工具，在 profile 生效时会给出警告：`mcp__` 模式之外使用通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）；不是完整 `mcp__<服务器>__<工具>` 形式的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具 —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建提示词时都会作为模板渲染：`${var}` 占位符替换为实时上下文值——未知变量保持原样，单独的 `$` 没有特殊含义，上下文中缺失的变量渲染为空字符串。`${parent_prompt}`（别名 `${base_prompt}`）嵌入这份文件的隐式父提示词：Agent 文件里是有效默认提示词，`SYSTEM.md` 里是内置默认，route 里是基础 profile。`${builtin_prompt}` 始终是内置默认，即使存在 `SYSTEM.md`。如果文件会替换默认提示词、但仍要保留已启用 plugin 提供的指令，请把 `${plugin_sections}` 放在希望出现这些指令的位置。可用变量见下文 SYSTEM.md 变量表。

Frontmatter 字段是封闭的：出现 Kiki 不认识的字段时，该文件会加载失败，并给出点名该字段的诊断；请删除或迁移不支持的字段（例如 Claude Code 的 `model`、OpenCode 的 `mode`）。`tools` 的逗号分隔写法可以使用，`name` 缺省时回退到文件名，因此只含 `description` 和正文的最小文件可以加载。

### 具名 profile route（实验功能）

具名 route 在现有 Agent 上增加专用运行方式，但不会创建新的权限身份。启动时在 `config.toml` 中设置 `[experimental] agent-profile-routes = true`，或设置 `KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`。

基础 profile 仍放在 `agents/<role>.md`。Route 放在 `agents/.routes/<role>/<route>.md`，规范 ID 为 `<role>.<route>`，基础 profile 段可用小写连字符或下划线分隔，route 段仍为小写 kebab-case。例如 `agents/.routes/reviewer/ui-k3.md` 定义 `reviewer.ui-k3`：

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
allowed_subagents: [explore]
service_tier: priority
request_params:
  temperature: 0.2
---

重点检查交互回归、无障碍与视觉一致性。
```

必填字段为 `id`、`profile`、`description` 和 `prompt_mode`。可选字段为 `whenToUse`、`model_alias`、`thinking_effort`、`service_tier`、`request_params`、`tools`、`disallowedTools`、`can_spawn_subagents`、`allowed_subagents`、`preferred_subagents`、`deny_subagents`。与普通 Agent 文件不同，route Frontmatter 使用严格解析。未知字段、非法类型、路径 / ID / profile 不匹配、同一来源内重复 ID、互斥的模型选择器只会让该 sidecar 被跳过并产生带 code 的诊断；基础 profile 和其他 route 仍会加载。`model_profiles`、`allowed_models`、`deny_models` 等仅属于 Agent 文件的字段在这里属于未知字段，会导致该 sidecar 被跳过。Route 可推荐默认 `model_alias`。偏离偏好会显示 advisory，但基础 profile 的硬模型与档位列表仍拒绝违规；请显式选择硬域内的覆盖值，或修正基础规则。

`prompt_mode` 始终保留基础提示词：`inherit` 要求正文为空；`prepend` 与 `append` 要求正文非空且不能包含 `${parent_prompt}` / `${base_prompt}`；`wrap` 要求正文必须且只能包含一次 `${parent_prompt}` 或 `${base_prompt}`。不提供无保护的 replace 模式。

Route 的 `tools` 与 `disallowedTools` 整体替换对应基础字段；`allowed_subagents` 与基础集合求交，`deny_subagents` 累积，`can_spawn_subagents: false` 不可重新打开，最近一层显式 `preferred_subagents` 替换较早的推荐。省略则继承。`allowed_subagents: []` 只关闭预设选择；完全叶子使用 `can_spawn_subagents: false`。调用方检查仍针对基础 role，因此 route 不能引入调用方原本不能派发的预设角色。

请求字段省略时继承基础值。`service_tier: null` 清除基础 tier，其他值直接替换；`request_params: null` 清除基础 map，传入 map 时按标量 key 覆盖。Route 声明的 `model_alias` 或 `thinking_effort` 是 route 默认值。`AgentRun` 只能在全部硬模型与档位列表内显式覆盖任一值；被接受的子 Agent 仍保留该 route 身份，同时标记为 detached 并记录结构化 advisory。若没有覆盖，缺失的 route 模型，或所选 provider / executor 无法执行的 effort，仍属于硬能力错误。

启用后，`AgentRun` 会列出经调用方基础 role allowlist 过滤后的精简 route 条目。条目只包含 route ID、基础 role、描述 / 使用提示、模型与 effort 默认值、被覆盖的字段名，绝不包含提示词正文。调用时传入 `route: reviewer.ui-k3`；可以省略 `profile` 让系统推导 `reviewer`，也可以显式传入这个匹配的基础 role。Role 不匹配会产生带 code 的错误。系统不会自动排序选择或静默回退。

恢复时不会重新选择或切换 route。Journal 会保存规范基础 role、route ID、渲染后的提示词、分层工具策略、denylist、子 Agent 限制、模型 / effort 锁、service tier 与请求参数。因此，即使后来关闭 flag，或 sidecar 被修改、删除、写坏，已有 routed Agent 仍从快照恢复；这些变化只影响新派发。旧 journal 继续兼容。

新派生 subagent 按此顺序选模型：具体的工具参数 `model_alias` → 生效 profile / route / caller lease 上的 pin → 显式配置的 `[subagent].default_model`。这些来源都不存在时派发以 `model.not_configured` 失败，不会创建子 Agent。调用方模型与主 Agent 的 `default_model` 都不是静默回退来源。在 profile、route、caller lease 中写 `model_alias: inherit`，才会绑定调用方当前已解析的模型。`AgentRun` 拒绝 `model_alias: "inherit"`：请写具体的已配置模型名，或省略参数以使用目标默认模型。按 profile、route 或 lease 配置继承模型时，也会跟随调用方的有效思考强度，但工具显式 `effort`，或 profile、route、caller lease、匹配的 `model_profiles` 条目上适用的 `thinking_effort` pin 优先。选择其他模型时，effort 仍按原有顺序解析：工具显式 `effort` → 匹配的 `model_profiles` 档位 → 绑定模型与 profile pin 的 `model_alias` 为同一规范模型时的 profile `thinking_effort` → 绑定模型自身默认档位。未知的具体 alias 无论来自派发参数还是 profile pin 都会报错。

使用 `AgentRun` 恢复时，`model_alias` 与 `effort` 同时省略则保留已保存绑定。`model_alias` 解析到同一规范模型时不产生变化。仅切换 `effort` 时，新值在下次空闲运行生效，已保存模型不变。切换到不同规范模型必须传 `allow_model_change: true`，且 `effort` 同时省略时重新解析目标模型的默认档位，不沿用旧 effort。`AgentRun` 恢复时同样拒绝 `model_alias: "inherit"`；显式换模请写具体模型名，或省略参数以保留已保存模型。字面标明的偏好与已保存的 route / caller lease pin，对满足硬域且可运行的恢复只产生 advisory。恢复准入会检查 profile、lease、匹配 model-profile 与继承的硬规则；拒绝时不会改动已保存绑定。Provider 无法执行的显式 effort、机器级模型禁止、executor thread 绑定限制和准入一致性检查也仍是硬错误。

新建子 Agent 时，省略 `model_alias` 和 `effort` 即可使用目标默认值。模型目录按硬规则过滤已配置模型，并单独标明有效 profile、lease、route 与 model-profile 候选的偏好。某个 alias 出现在另一目标下，不代表它在这里也被推荐或允许。显式可执行的覆盖只有同时满足全部硬边界才被接受。把 `preferred_models` 与默认 `model_alias` 一起声明，可以发布推荐模型池；保留 `model_profiles` 提供逐模型默认值与指引。Route 的档位覆盖（包括 `service_tier: null`）不会清除模型级档位配置。

原生模型治理先解析 `[models]` alias，再按规范模型身份比较；外部 executor 使用实际生效模型 ID。`allowed_models`、`deny_models`、`allowed_efforts` 不论作用域或派遣策略，始终是硬规则。`preferred_models`、`discouraged_models`、`preferred_efforts`、route 默认值与 caller lease pin 是软建议；偏离事实保存在绑定中，并在父侧 `AgentRun` 结果里给出摘要。字段与校验规则见[配置参考](../configuration/config-files.md#subagent)。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。预设 allow / deny 规则也会过滤 `AgentRun` 的目录，并在实际派发前再次检查；派发开关还控制新建 Markdown 文件子 Agent。继续已有子 Agent 不受新建限制。权限规则仍是独立的控制层，用于决定哪些操作需要审批。
:::

自定义 Agent 作为被派发的 subagent 运行时，Kiki 会注入一段简短的委派说明：最后一条消息就是交给调用方的完整交付。独立宿主调用（MCP / SDK）用另一段说明：没有父 Agent。main agent 绑定不注入。在正文里写 `${delegation_context}` 可指定位置，否则前置。profile 上设 `delegation_notice: off`，或在 `config.toml` 写 `[agents.delegation] sub = false` / `independent = false`，即可关闭。如需替换文案，通过 [`PromptOverrides`](../configuration/config-files.md#prompt) 覆写 `delegation.sub.notice` 或 `delegation.independent.notice`。旧的 delegation `.md` 路径值不再接受；布尔 gate 与 `delegation_notice: off` 始终优先于文案覆写。

### 选择 main agent

两个 CLI flag 用于选择驱动新会话的 Agent，在 print 模式（`kiki -p`）和交互式 TUI 中均可使用：

- **`--agent <name>`**：以指定 Agent 作为 main agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。该 flag 只接受一个文件：不可重复传入，也不能与 `--agent` 同时使用。

两个 flag 都仅在新建会话时有效——都不能与 `--session`/`--continue` 组合。Agent 在会话创建时绑定，恢复会话时会自动还原已绑定的 Agent，因此恢复时不需要（也不允许）携带这些 flag。

在 print 模式下，显式 `--model` 优先于所选 profile 的 `model_alias`。省略 `--model` 时，引擎先使用 profile 的模型 pin，仅在 profile 未指定模型时使用 `default_model`。因此，钉死模型的 profile 无需全局默认模型也能运行；subagent 不使用这个主 Agent 默认值，但可以使用显式 `[subagent].default_model`。main agent 没有调用方，即使设置了 `default_model` 或 `--model`，其 profile 也不能固定 `model_alias: inherit`。

例如：

```sh
kiki --agent reviewer
kiki -p --agent reviewer "审查这个分支上的改动"
```

这些 CLI flag 选择启动会话的 profile，不用于修改恢复中的会话。GUI 可以在提交下一条消息时请求切换主档。Main agent 的选模以用户为准，优先于 profile 模型规则：偏离推荐不警告，硬规则违规只显示非阻断警示。在同一 TUI 进程内后续新建的会话（例如通过 `/new`）使用默认 Agent。

定制 main agent 时，在正文中引用 `${parent_prompt}` 或 `${base_prompt}` 可保持有效默认提示词中已有的环境、工作区指令、Skill 和 plugin 注入生效。`${builtin_prompt}` 始终是出厂默认提示词，即使存在 `SYSTEM.md`。如果要替换默认提示词、但只保留 plugin 提供的指令，请改用 `${plugin_sections}`。正文同时不引用 `${parent_prompt}` / `${base_prompt}` 和 `${plugin_sections}` 时，会完全拥有自己的提示词并排除 plugin 指令，适合自包含的 subagent。

### 用 SYSTEM.md 覆盖 main agent 的系统提示词

希望永久覆盖默认 main agent、而不必每次启动都传入 `--agent` 或 `--agent-file` 时，可以写一份 `$KIKI_HOME/SYSTEM.md`（默认：`~/.kiki/SYSTEM.md`，随 `KIKI_HOME` 移动）。文件缺失或为空时不生效。读取或解析失败会产生带路径的诊断；若当前进程曾成功加载该文件，则保留它最后一次有效的 profile，其他 Agent 文件仍正常重载。开头为 `---` 的文件出现 YAML 语法错误时，绝不会被重新解释为遗留提示词。修复文件可替换保留的版本，删除文件则移除覆盖；没有历史有效版本时，跳过这份非法覆盖。SYSTEM.md 在包括交互式 TUI 会话在内的所有启动方式下生效。

解析方式看文件第一行：

- **遗留正文。** 文件并非以 `---` 加 YAML mapping 开头。只替换提示词；描述、工具集与允许委派的 subagent 列表仍沿用内置默认。不需要也不读取 Frontmatter。
- **普通 profile。** 文件以 `---` 开头，且围栏解析为 YAML mapping。按名为 `agent` 的普通 Agent 文件加载，`override` 强制为 `true`。未声明的工具字段和子角色权限沿用内置默认；已声明的预设权限收窄这一层，显式推荐替换继承的推荐。

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

`AGENTS.md` 提供在各文件声明的目录作用域内适用的指令；冲突时更具体的文件优先。它们从属于系统策略与当前用户请求，不能改变工具 schema、权限或宿主控制。运行时快照交付这些作用域规则；记忆仍是参考资料。

Kiki 会同时加载 `$KIKI_HOME/AGENTS.md`（默认：`~/.kiki/AGENTS.md`）与工作区根目录的 `AGENTS.md`。根目录的 `.kiki/AGENTS.md` 会替代用户级文件，根目录的 `AGENTS.md` 仍然生效。会话启动时，也会加载从项目根目录到当前工作目录这条路径上适用的指令文件。文件名匹配不区分大小写。项目边界上方、`~/.agents/AGENTS.md` 和旧的 `.kimi-code/AGENTS.md` 路径都不会被发现。

获准执行的文件工具访问另一目录时，Kiki 会沿该目录的祖先路径检查 `AGENTS.md` 与 `.kiki/AGENTS.md`，不会遍历无关子树。如果文件工具即将写入、但尚未看到适用规则，Kiki 会先提供完整的当前规则。第一次写入返回可重试结果，不修改文件；Agent 阅读规则后，可按现有权限策略重试。这不会增加一次用户审批。Bash 的发现依赖可识别的路径和显式工作目录，不会检查 Shell 命令动态计算出的所有路径。

当前规则已完整存在于运行时快照，或已通过成功的 `Read` 完整读取时，不会因为另一个工具访问该目录就再次注入。部分读取或截断结果不算完整覆盖。文件发生变化、换到另一主机，或相关上下文被移除后，可能需要重新披露。初始目录列表只展示一层样本，Agent 会用 `Glob` 继续探索；规则正文不会随目录样本一起缩短。

## 会话目录中的存储位置

subagent 的运行状态持久化到当前会话目录的 `agents/` 子目录下，每个 subagent 实例对应一个独立目录，其中包含按时间顺序记录提示词、消息历史与最终状态的 `wire.jsonl` 文件。后台 subagent 还会通过 `tasks/` 子目录暴露生命周期状态。

::: warning 注意
会话目录、wire 文件和任务记录都属于本地调试材料，可能包含用户 prompt、命令输出、仓库路径、工具返回内容或凭证痕迹。不要把这些文件直接提交到公开仓库、issue 或聊天记录里；如确需分享，请先脱敏。
:::

## 下一步

- [Hooks](./hooks.md) — 在 subagent 完成等关键节点触发本地脚本通知或拦截
- [Agent Skills](./skills.md) — 给 subagent 注入专业知识和工作流程
