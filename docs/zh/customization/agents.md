# Agent 与 subagent

每个会话都由一个 **main agent** 驱动：它跟随你的意图、规划步骤、调用工具，并向外派发 **subagent** 处理更聚焦的子任务——探索陌生代码库、并行审阅多处实现，或在不撑满主上下文的前提下规划一次大型重构。

subagent 收到任务描述后在自己的上下文里工作，最后把结论返回。它不直接和你对话，中间的思考与工具调用记录也不进入 main agent 的历史。

想先了解 profile 是什么、文件在哪、改动何时生效，读 [Agent profile 概念与设计](./agent-profiles.md)；本页是字段与行为参考。

## 内置 subagent

全新安装包含主 `agent` profile 和两个 subagent profile：

- **`general`** —— 默认 subagent，可以读写文件、执行命令、搜索代码，不继续派发子 Agent。
- **`explore`** —— 只读，用于探索代码库、搜索和总结。

另有两个按需创建、并非预装的角色：`implementer` 负责一项工程任务直到验证与交付，`reviewer` 作为只读叶子独立审查决策或已完成的工作。在对话中提出即可（GUI 首次启动后的 `/kiki-ops` 会在你眼前这件事正好缺一个角色时才提），`kiki-profile` skill 会把完整模板写到 `$KIKI_HOME/agents/<角色>.md`（默认 `~/.kiki/agents/`），已存在的文件不会被覆盖。两个模板都写有 `model_alias: inherit`，因此角色跟随父 Agent 当时使用的模型；模板不设置 `thinking_effort`，以后可在设置里固定模型。

顶层配置 [`skip_builtin_profile_installation`](../configuration/config-files.md#顶层字段) 会跳过向 `agents/builtin/` 安装指定的内置模板，已有的副本不受影响。要从 subagent 的发现与派发列表中隐藏已安装的 profile，用 `disabled_named_profiles`；main `agent` 绑定始终可用。

## 调用方式

subagent 由 main agent 自行判断何时派发，你也可以直接指定："先用 explore 把相关文件梳理一遍再动手"。

每次派发都会以审批请求的形式出现（命中 allow 规则或处于 YOLO 模式时除外），派发前可以先看任务描述。subagent 支持后台运行，完成后结果自动回到 main agent；也可以唤回已有实例继续同一任务。

## 具名子 Agent

主 `agent` profile 默认就有三个子 Agent 工具，不需要实验开关：`AgentRun`、`AgentList` 和 `AgentSend`。内置 subagent profile 没有它们。每个调用方只能看到自己直接创建的子 Agent——孙级或别人创建的都不是有效目标。

`AgentRun` 启动新的子 Agent，或继续已有的。每次调用都需要 `prompt` 和一个 3–5 个词的短 `description` 供界面展示。新派生还可以设置：

| 参数 | 说明 |
| --- | --- |
| `profile` | 运行哪个 subagent 角色。省略时用显式配置的 `[subagent].default_profile`；没有该键则用内建通用 subagent。显式留空必须指定目标。 |
| `profile_file` | subagent role 的 Markdown 文件，绝对路径或工作区相对路径。它是角色定义而非共享提示词模板，且与 `profile`、`route`、`resume` 互斥。 |
| `route` | 基础 profile 的具名 route。 |
| `name` | 之后再次寻址该子 Agent 用的名字：匹配 `^[a-z0-9_]+$`，不能是 `root`，会话内唯一。 |
| `background` | 省略时，调用方是 main 则后台运行，是 subagent 则前台等待；`true` / `false` 分别强制后台与同步等待。 |
| `model_alias`、`effort` | 省略则沿用已保存值或默认值。 |

继续直属子 Agent 时把 `resume` 设为它的名称或 agent id，它与 `name`、`profile`、`profile_file`、`route` 互斥。`allow_model_change` 只在 `resume` 同时显式传入、且解析到不同规范模型的 `model_alias` 时有意义。

新派生按此顺序选模型：具体的 `model_alias` 参数 → 生效 profile / route / caller lease 的 pin → 显式配置的 `[subagent].default_model`；三者都没有则以 `model.not_configured` 失败，不创建子 Agent，未知 alias 同样报错。effort 单独解析，来源可能是工具调用、route、caller lease、profile 或模型自身——[完整顺序见下文](#具名-profile-route-实验功能)。`resume` 时省略 `model_alias` 和 `effort` 会保留已保存绑定，解析到同一规范模型的 alias 不产生变化，换到不同规范模型则需要 `allow_model_change: true`。

`preferred_models`、`discouraged_models`、`preferred_efforts` 以及 route / caller lease 的 pin 都是软建议：满足硬规则的覆盖会带着结构化 advisory 继续执行。`allowed_models`、`deny_models`、`allowed_efforts` 在任何作用域都是硬规则。机器级 `[subagent].deny_models`、不受支持的模型能力、route 身份、缺少换模确认以及 executor / thread 限制都是硬错误；外部 executor 无法修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。

Agent 任务默认 2 小时超时，全局限制用 `[subagent] timeout_ms` 或 `KIKI_SUBAGENT_TIMEOUT_MS` 配置（`0` 关闭）。print 模式没有超时，也不提供单次调用 timeout 或供应商参数透传。

后台派发需要 `TaskList`、`TaskOutput` 和 `TaskStop`。这三个工具被关闭时，main 省略 `background` 会在启动前被拒绝，而不是改为前台等待——请启用工具，或为真正的同轮依赖显式传 `background: false`。main 前台等待期间，steer 或 **Send now** 会把子 Agent 转到后台而不终止它，下一安全步骤即可读到新输入，完成时仍自动通知父 Agent；普通排队消息不会释放这个等待。main 轮次停止不会连带取消已转入后台的子 Agent，要停止请用 `TaskStop`。详见 [`AgentRun` 工具参考](../reference/tools.md#协作类)。

`AgentRun` 选模时，`restrict_models_to_menu` 关闭（默认）意味着 profile 菜单只是候选而非封闭列表；开启后只有作者声明的默认 `model_alias` 和 `model_profiles` 条目可选，菜单外的选择被拒绝而不回落。见 [模型菜单与硬边界](./agent-profiles.md#模型菜单与硬边界)。

`profile_file` 直接提供角色定义，无需注册成预设，也不按文件中的名字套用预设 allow / deny 名单。`allowed_subagents: []` 仍允许这条路径，`can_spawn_subagents: false` 则禁止创建任何子 Agent。路径可为绝对路径或工作区相对路径，解析链接后的真实路径仍须位于允许的目录内。

`AgentList` 返回直属子 Agent。默认列出运行中的和没有跟踪任务的；需要已结束或失败的，再传 `include_finished: true`。最多返回 50 条，运行中的排在前面。

`AgentSend` 把消息排进邮箱并尽早送达：子 Agent 运行中时在下一个 step 边界被 steer 进当前 turn，空闲且可恢复时以该消息启动一次新运行，完成后照常通知父 Agent。用 `name` 或 agent id 指定目标。

`AgentNotify` 方向相反，只有 subagent 可用：它把一条 fire-and-forget 消息排进父 Agent 邮箱，父 Agent 运行时在下一个 step 边界读到，空闲时在下一次运行时读取。main agent 没有父 Agent，永远拿不到它。在 `config.toml` 里设 `[agents] notify_parent = false` 可全局关闭，默认开启。

## Peer thread 通信

Peer thread 通信让 main agent 协调同一台本地主机上的其他 Kiki 会话，包括其他工作区的会话。它与上面的子 Agent 工具相互独立，默认关闭。启用后会话的主 agent 会获得 `ThreadList`、`ThreadRead`、`ThreadSend` 和 `ThreadWait`。subagent 默认没有这些工具；在其 profile 的 `tools` 中点名 `ThreadList`、`ThreadRead`、`ThreadWait` 即可开放，而 `ThreadSend` 始终仅供主 Agent 使用，因为它以父会话的 peer 身份发送。主 Agent 想创建独立会话的话，直接用 [`ThreadCreate`](../reference/tools.md#协作类) 即可，无需启用本功能。

Thread 引用标识主机、工作区和会话。`ThreadList` 返回后续调用所需的引用；`ThreadRead` 读取已完成的主 Agent turn，不恢复冷会话；`ThreadSend` 从当前主 Agent 会话派生来源；`ThreadWait` 最多等待 8 条 thread 的活动，最长 60 秒。消息不能跨主机。

只有来源 thread 的主 Agent 调用 `ThreadSend` 才会记为 peer 来源。REST 和 Klient 的 `global.threads` facade 只接受目标 thread，消息记为 user 来源，外部客户端不能自行声明来源。

在 `config.toml` 中设 `[thread_communication] enabled = true` 全局启用。发送消息可能恢复冷会话并消耗模型额度。工作区可以持久设置启用或禁用覆盖值，但全局开关关闭时无法反向启用。接口见 [服务 API](../server/rest-api.md#会话租约与-peer-thread)。

## 上下文隔离与资源开销

subagent 只看到给它的任务描述，看不到 main agent 的对话，中间过程也不会回流，只有最终结果回到 main agent 的上下文。由此带来两点：长会话里主上下文保持可读；多个 subagent 可以并行而不互相干扰。

每个 subagent 都单独消耗 token，小任务直接交给 main agent 更省。

## 权限继承

subagent 继承 main agent 的权限决定：通过 `/permission` 或审批面板接受的「始终允许」规则对它派发的所有 subagent 生效，同类调用不必反复审批。`AgentRun` 本身默认放行，因此 main agent 可以多次委派而不打断你。

要让某类工具在 subagent 中始终不可用，收紧 main agent 上对应的权限规则。

## 自定义 Agent

自己的 Agent 也是 Markdown 文件：Frontmatter 声明名称、描述和工具权限，正文是系统提示词。Kiki 会自动发现它们并与内置 profile 并列，既可以派发为 subagent，也可以在启动时选为 main agent。

### 派遣能力可见性

GUI 的 main agent 选择器列出当前工作区或工作目录下生效的 profile。主档带有 `main: true`；覆盖内置 profile 的文件省略 `main` 时继承内置值，显式的 `main: false` 会被保留，因此 `SYSTEM.md` 无需额外 Frontmatter 就仍是主档。把默认 profile 从 subagent 发现中移除，不会取消它的主绑定，也不会丢弃已生效的文件覆盖。字段定义见 [Agent 文件格式](#agent-文件格式)。

在**设置 → 智能体**中选择工作区，可以查看默认主档、实际来源与 subagent 能力。文件 profile 可在其显示的来源处直接编辑；编辑遗留 `SYSTEM.md` 的常用字段会添加 Frontmatter 并保留提示词正文。已选配置后来不可用时仍保留原值并显示诊断，方便换一个。

### Profile 热刷新与进行中的会话

agent 文件被监听并在变更时热刷新，且热刷新不会打断进行中的会话：已在运行或恢复的 agent 继续使用绑定时的提示词与约束快照，哪怕 profile 被编辑、设为 `private`、删除或失效。因此改动只对**新的**派遣生效，向私有或已删除的 profile 派遣会得到明确报错；冻结的派遣列表会跳过失效目标，而不是让整段对话失败。恢复一个 profile 已不存在的旧记录时会降级到默认 profile 并给出警告，模型、effort 与执行器仍会校验。

### 选择引擎与它的 profile

输入区状态栏最左侧的那个控件用一个面板回答一个问题——本会话由什么运行。第一项是 Kiki 自身，其后是各个外部引擎，每个引擎下面列出该引擎自己的主档。每个引擎的第一行都是该 harness **原样运行**：不套用 Kiki profile、不注入 Kiki 提示词和工具，模型、思考强度与审批模式都归它自己。在某个引擎下选中一个 profile 会同时选定引擎与 profile，两半永远不会互相矛盾。

旁边的模型控件保持独立：模型是在你选定的引擎**之内**的选择。使用外部引擎时，保留**跟随引擎配置**即可沿用 profile 或引擎默认值，也可以填写引擎自己的模型 ID，作为本会话的覆盖值。重新选择「跟随」会清除会话的模型与思考强度覆盖，不改动已保存的 profile 或引擎设置。Kiki 原生模型列表不限制外部模型 ID。

模型与 profile 目录在后台加载，尚未完成时也可按保留的选择发送；实际绑定由服务端校验。目录请求失败会提供重试，不替换你的选择；已经确认缺失或失效的选择仍需先修正。

新会话立即应用所选引擎。已经说过话的会话里，改动从你的下一条消息起生效，换一个引擎会先确认一次。确认框回答的正是你真正不确定的两件事：新引擎从自己的上下文开始——Kiki 不会把旧对话交接给它，也不会续用旧引擎的会话——而这段对话本身完整保留在 Kiki 里，随时可读。正在运行的那一轮会用当前引擎跑完，控件则把新选择标记为待生效，直到下一条消息带上它。

**设置 → AI → 外部引擎**中的「此引擎运行时 Kiki 补充的内容」为该引擎设定默认值，作用于所有未自行覆盖的会话：harness 能触及哪些 Kiki 工具组和 hooks、能否派遣 Kiki 子 agent，以及 profile 提示词如何投递。这里全部留空等同于在输入区选择「原样运行」那一行，因此你本就信任的 harness 会和它自己的 CLI 一样运行。

### 外部直连执行

harness 决定实际运行程序，profile 是可选定制，模型则是在该 harness 内选择。main agent 使用 [REST execution 选择](../server/rest-api.md#会话) 时，省略 `profile` 就直接运行外部程序。没有会话覆盖或 [harness 默认设置](../configuration/config-files.md#外部-harness-默认设置) 时，Kiki 不发送 profile 提示词、cognition、共享字段、记忆、hooks 或 MCP 工具，也不指定模型、档位、审批模式或 Codex 沙箱策略。原生执行不选 profile 时保持既有 Kiki 默认行为。

直连保留配置的启动环境、home 和工作目录，但实际程序必须解析到你预期的 CLI 同一可执行文件及设置来源。ACP adapter 可能启动 SDK 自带 binary 或显式覆盖，而不是 PATH 上的 CLI；不选 profile 不会让两者自动变成同一个程序。仅登录观测未知并不阻止启动。

### 外部 ACP profile 的投递

对于对外使用的 ACP（Agent Client Protocol）执行器，只有 harness 接受 `session/new` 的 `_meta.systemPromptOverride` 扩展时，Kiki 才把冻结的 profile 作为系统提示词发送。内置 `grok-acp` 执行器启用，其他 ACP 执行器把 profile 放在第一条 User 消息的前言里。自定义 harness 支持该扩展时，可在 `config.toml` 的 `[agent_executors.<id>]` 中设 `profile_delivery = "system_prompt_override"`；会忽略该扩展的 harness 不要启用，因为 Kiki 随后就不再附加 User 消息前言作为后备。

覆写只在创建**新的远端会话**时生效，`session/resume` 和 `session/load` 不会重新发送；已有远端会话保留最初的投递方式。旧的纯 profile 派发在重建远端会话时会附上有长度限制的对话交接；main agent 的 `execution` 路径在代际切换或重新连接失败后不会发送旧 Kiki 历史。系统提示词覆写可能替换 harness 原有的默认系统提示词，因此只对适合这种替换的 harness 启用。

旧的纯 profile 绑定中，内置 `kimi-acp` 执行器会把已配置的 MCP 服务器转发给 Kimi Code；`execution` 路径不会自动转发工作区 MCP。`0.37.0` 起、不含 `0.39.0` 的 Kimi CLI 不接受 ACP stdio MCP 服务器，预检会警告 MCP 工具将失败并建议升级；警告不阻止转发，无法探测版本时也不发这条警告。

### 外部 main agent 的委派

外部执行器可以担任 main agent。要让它派遣 Kiki subagent，在其 profile 中添加 `allow_kiki_subagents: true` 并把该 profile 绑定为 main agent。main agent 的 `execution` 路径也可在会话覆盖或 [harness 默认设置](../configuration/config-files.md#外部-harness-默认设置) 中开启；profile 未声明该字段时继承这些默认值。没有任何显式值时为 `false`，也不会为外部子 Agent 开启委派。

Kiki 把 MCP 工具（harness 调用 Kiki 的桥）附加到**已有会话**，不另建 seat 会话。harness 需要支持本机 stdio MCP，且其进程能找到 `kiki`。profile 的派发开关、预设权限与推荐、模型约束和父级通知策略仍然生效。改开关后需重新绑定 main profile，已有绑定保留冻结快照；在已绑定的 main profile 上关闭委派或关闭执行器都会撤销这个桥。

子 Agent 的完成回执非阻塞地排回同一个 main agent：它忙碌时等当前轮次结束，空闲时直接唤醒它。父级通知使用同一段对话，仍受 `allow_parent_notify` 和配置的通知策略约束。

Codex app-server 的 MCP 工具调用可能另需厂商审批，Kiki 把它映射为持久化审批交互，manual 或 auto 模式（`on-request`）下由你回答。Full access（YOLO）只在 Codex 层预批准附加的 `kiki-harness` MCP server，其调用仍受 Kiki 自身的能力和执行策略约束；其他 MCP server 保留原审批策略，workspace-write 沙箱不变宽。

外部交互取决于 harness 协商出的能力。ACP 历史 fork 在支持时使用 `session/fork`；要精确定位到 Assistant 消息，还需要 Claude、Codex 或 DeepSeek adapter 支持的 AIR fork 定点扩展，无法表达的位置会新建远端会话并附上有长度限制的对话交接，而不会继续源远端会话。Codex 与 DeepSeek 的 ACP 表单问题映射到 Kiki 持久化问题交互，不支持的复杂表单和 URL 模式请求会被拒绝；Grok 的计划审批映射到持久化计划审阅交互。

### 外部 main agent 的 Kiki 上下文

在外部 main profile 中配置 `kiki_context`，即可独立于委派开关开启 Kiki 原生上下文工具：

```yaml
executor: claude-acp
allow_kiki_subagents: true
kiki_context: [memory, board, cron, threads, history, hooks]
```

旧的纯 profile 绑定中，不设置列表表示全部关闭。main agent 的 `execution` 路径中，profile 未声明该字段时继承 [harness 默认设置](../configuration/config-files.md#外部-harness-默认设置)，会话覆盖优先；`[]` 明确关闭全部组。改完需要重新绑定 execution。工具在桥启动时一次性注册，之后开启的工具组不会改写正在运行的 harness 工具列表。profile 的工具策略与功能设置仍然生效，只有外部 main agent 能取得这个桥。

| 工具组 | MCP 工具 |
| --- | --- |
| `memory` | `kiki_memory_read`、`kiki_memory_search`、`kiki_memory_write` |
| `board` | `kiki_board_read`、`kiki_board_write` |
| `cron` | `kiki_cron`（`action: create`、`list` 或 `delete`） |
| `threads` | `kiki_thread_list`、`kiki_thread_read`、`kiki_thread_send` |
| `history` | `kiki_history_search`、`kiki_history_read` |
| `hooks` | 消息上下文注入，不增加模型可调用的工具 |

这些工具沿用 Kiki 原生参数和执行策略，包括审批、persona 可见性、工作区访问、记忆审核和 Plan 模式限制。调用归属到已有 main agent，既不是用户写入也不新建 seat 会话；桥的 token 无法访问普通 REST 端点或选择别的调用方会话，原生读取工具则声明 MCP 只读标记。厂商审批与 Kiki 审批是两层，上面提到的 Codex Full access 预批准是唯一的例外。

`hooks` 以消息形式发送记忆摘要和未送达的提醒、工作笔记，不改写系统提示词或工具 schema；桥存活期间相同内容只注入一次，hook 内容在 Kiki 时间线中以 `hook_result` 来源记录。Kiki 只写临时的进程或会话配置，不修改 harness 的全局 hook 设置。

| Harness | 注入方式 |
| --- | --- |
| Claude ACP | 通过 `session/new` 元数据传入临时命令 hook settings；`SessionStart` 与 `UserPromptSubmit` 使用 `additionalContext`。 |
| Codex app-server / ACP | 临时 `hooks.json` 定义转为进程或会话配置，仅固定信任这些命令；`SessionStart` 与 `UserPromptSubmit` 使用 `additionalContext`。 |
| Antigravity | 隔离的 `GEMINI_HOME` 中配置 `PreInvocation.injectSteps`。 |
| Grok ACP | 原生会话级 ACP `Stop` 回调注入 `additionalContext`；session-start 和 prompt-submit hook 无法注入上下文，因此 Kiki 保留工具执行前的消息前缀。 |

Claude 和 Codex 的 `PreCompact` hook 只准备可追踪的交接快照而不注入，状态摘要在 Claude 压缩后的 `SessionStart` 或 Codex 准备事件之后的下一次 `UserPromptSubmit` 恢复。

### 重建会话上下文

修改提示词来源后，在会话输入区的 profile 选择器中选择「重建上下文」。Kiki 会从磁盘重新加载当前 profile、提示字段覆写、Agent Skills、`AGENTS.md` 指令以及 plugin 的提示词和 session-start 注入，协调其余运行时上下文注入，后续请求改用重建后的快照。对话消息保留。轮次运行期间该操作不可用。

「派遣能力」面板（在新会话的工作区选择器旁或会话右栏）展示 subagent 的 profile、route、执行器，以及默认模型和思考力度的来源。默认配置是否有效与当前是否允许启动分开显示，面板反映当前 Agent 的工具目录，包括 [Plan 模式下的只读研究限制](../reference/tools.md#plan-模式) 和拒绝启动的原因，但不检查外部供应商健康状况。模型、profile 或思考强度不可用时，发送前请换一个；仅仅处于加载中或目录请求失败不代表你保存的选择失效。

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

用户、项目和 `extra_agent_dirs` 根目录下的 Agent Markdown 文件都会被监听，新增、修改或删除后约 200 ms 自动重载，因此运行中的会话无需 `/reload` 或重启即可派发新出现的角色。`$KIKI_HOME/SYSTEM.md` 同样被监听。已创建的 `AgentRun` 工具实例保留角色描述的冻结快照，展示可能暂时滞后，实际派发立即使用重载后的 profile。

**Plugin 级**：已启用 plugin 在 manifest `agents` 字段中声明的目录（省略时自动取 plugin 根下的 `agents/`），见[插件 Agent](./plugins.md#插件-agent)。Plugin 定义优先级低于用户文件，也低于已安装的内置副本。

**内置副本** 安装在 `$KIKI_HOME/agents/builtin/`，作为用户作用域加载，在两个用户目录的普通文件之后扫描，因此同名用户定义始终优先，无需 `override: true`，也不受文件名字母序或安装时间影响；同名冲突诊断会列出双方路径。通过 `--agent-file` 加载的文件优先于所有目录作用域，仅对本次启动生效。另有 `$KIKI_HOME/SYSTEM.md` 永久覆盖默认 main agent 的系统提示词，见下文。

::: warning 信任模型
Agent 文件属于提示词配置，项目级文件来自仓库本身——包括你刚 clone、尚不可信的仓库。名为 `agent.md` 的项目文件可以替换**默认 main agent 的整个系统提示词**，`general.md` 可以替换默认 subagent 类型，无需 `override: true`。与从属于系统策略的 `AGENTS.md` 内容不同，这样的文件**就是**系统提示词。在不熟悉的仓库里运行 Kiki 之前，先检查其中的 `.kiki/agents/` 和 `.agents/agents/`。
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
| `recipe` | 否 | 已安装 Recipe 的 id，可加 `installation:` 前缀。只为该 profile 的原生绑定贡献提示和模型设置，位于模型 Recipe 之后、profile 显式值之前；`off` 撤回本 profile 的贡献。先安装来源，绑定时不下载包。见 [Recipe 模型配方](./prompt-fields.md#recipe-模型配方) |
| `prompt_overrides` | 否 | 该 profile 的提示词字段覆写，可含 `files` 与 `fields`。此层覆盖全局与模型值；匹配的 `model_profiles[].prompt_overrides` 条目再覆盖它。详见 [`prompt`](../configuration/config-files.md#prompt) |
| `system_prompt_mode` | 否 | 提示词正文模式：`replace`（默认）、`prepend`、`append` 或 `inherit`。`inherit` 要求正文为空且 `prompt_overrides` 非空；它保留下层同名 profile 定义，并应用本文件的字段覆写 |
| `service_tier` | 否 | Profile 默认服务档位：`auto`、`default`、`flex` 或 `priority`。匹配的 `model_profiles` 显式值优先于本 profile 默认值，后者优先于模型与 Recipe 默认值。目前只有 `openai_responses` 协议会把它编码进请求体，其他协议静默忽略 |
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

原来的作者字段 `subagents`、`subagent_policy` 和宿主设置 `main_dispatch_policy`、`subagent_dispatch_policy` 已移除。只用于建议的角色名移到 `preferred_subagents`，真正的预设边界移到 `allowed_subagents` / `deny_subagents`，原来的叶子角色改用 `can_spawn_subagents: false`；source 与 lease mapping 仍放在 `allowed_subagents` 下。已保存的绑定会升级，不改变角色、模型、提示词或来源快照。结构化编辑保留你没有提到的字段，`null` 删除本地声明，`[]` 写入显式空列表。

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

这份配置只允许默认的 `fast-model` 和菜单条目 `review-model`，不接受任意显式覆盖；其他硬规则还能进一步收窄。只做推荐的菜单保持关闭，用 `preferred_*` / `discouraged_models`；预算、合规、部署或下级树这类独立边界用 `allowed_models` / `deny_models`。三场景选择规则见 [何时开启](./agent-profiles.md#何时开启)。

`allowed_models`、`deny_models`、`allowed_efforts` 在所有作用域都按字面硬语义执行，没有旧的软模式。如果某个列表本来只是建议，请在它出现的每个作用域改名为 `preferred_models`、`discouraged_models` 或 `preferred_efforts`，真正的硬边界保持不变。恢复一个超出硬规则的已保存绑定会被拒绝——选一个许可值或修改规则后重试。

工具名精确匹配且区分大小写；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。以下三种写法永远匹配不到任何工具，并在 profile 生效时给出警告：`mcp__` 模式之外的通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）、不是完整 `mcp__<服务器>__<工具>` 的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具，匹配整个服务器要用 `mcp__github__*`），以及已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建时作为模板渲染：`${var}` 占位符替换为实时上下文值，未知变量保持原样，单独的 `$` 没有特殊含义，上下文缺失的变量渲染为空字符串。`${parent_prompt}`（别名 `${base_prompt}`）嵌入这份文件的隐式父提示词：Agent 文件里是有效默认提示词，`SYSTEM.md` 里是内置默认，route 里是基础 profile。`${builtin_prompt}` 始终是内置默认，即使存在 `SYSTEM.md`。若文件替换了默认提示词但仍要保留 plugin 贡献的指令，把 `${plugin_sections}` 放在它们该出现的位置。变量表见下文 SYSTEM.md 一节。

Frontmatter 字段是封闭的：出现 Kiki 不认识的字段时文件加载失败并给出点名该字段的诊断，请删除或迁移（例如 Claude Code 的 `model`、OpenCode 的 `mode`）。`tools` 支持逗号分隔写法，`name` 缺省时回退为文件名，因此只含 `description` 和正文的最小文件也能加载。

### 具名 profile route（实验功能）

具名 route 在现有 Agent 上增加专用运行方式，但不创建新的权限身份。启动时在 `config.toml` 中设置 `[experimental] agent-profile-routes = true`，或设置 `KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES=1`。

基础 profile 仍放在 `agents/<role>.md`，route 放在 `agents/.routes/<role>/<route>.md`，规范 id 为 `<role>.<route>`，route 段使用 kebab-case。例如 `agents/.routes/reviewer/ui-k3.md` 定义 `reviewer.ui-k3`：

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

必填 `id`、`profile`、`description`、`prompt_mode`；可选 `whenToUse`、`model_alias`、`thinking_effort`、`service_tier`、`request_params`、`tools`、`disallowedTools`、`can_spawn_subagents`、`allowed_subagents`、`preferred_subagents`、`deny_subagents`。route 的 Frontmatter 解析严格：出现未知字段（包括仅属于 Agent 文件的 `model_profiles`、`allowed_models`、`deny_models`）、类型错误、路径 / id / profile 不匹配、同一来源内 id 重复或模型选择器互斥时，只有该 sidecar 被跳过并给出带 code 的诊断，基础 profile 和其他 route 照常加载。偏离推荐模型会显示 advisory，但基础 profile 的硬规则仍然拒绝违规。

`prompt_mode` 始终保留基础提示词：`inherit` 要求正文为空；`prepend` 与 `append` 要求正文非空且不能包含 `${parent_prompt}` / `${base_prompt}`；`wrap` 要求正文包含 `${parent_prompt}` 或 `${base_prompt}` 恰好一次。

Route 的 `tools` 与 `disallowedTools` 替换基础对应字段，`allowed_subagents` 与基础集合求交，`deny_subagents` 累积，`can_spawn_subagents: false` 不可重新打开，最近一层显式 `preferred_subagents` 替换较早的推荐，省略则继承。`allowed_subagents: []` 只关闭预设选择。调用方检查仍针对基础 role，route 无法引入调用方派不出去的预设角色。

请求字段省略时继承基础值：`service_tier: null` 清除 tier，`request_params: null` 清除 map，传入 map 时按标量 key 覆盖。route 声明的 `model_alias` 或 `thinking_effort` 是该 route 的默认值，`AgentRun` 只能在硬模型与档位列表内覆盖其中之一；没有覆盖时，缺失的 route 模型或 provider / executor 无法执行的 effort 属于硬能力错误。

`AgentRun` 会列出经调用方基础 role allowlist 过滤后的 route 条目，只包含 route id、基础 role、描述、模型与 effort 默认值和被覆盖的字段名，不含提示词正文。传入 `route: reviewer.ui-k3`；省略 `profile` 即可推导出 `reviewer`，也可以显式传入这个匹配的基础 role，不匹配会报带 code 的错误。

恢复时不会重新选择或切换 route：journal 保存规范基础 role、route id 以及渲染后的提示词、工具策略、denylist、子 Agent 限制、模型与 effort 锁、service tier 和请求参数，因此即便之后关闭 flag 或 sidecar 变化，已有 routed Agent 仍从快照恢复，变化只影响新派发。

新子 Agent 的选模顺序是：具体的 `model_alias` 参数 → 生效 profile / route / caller lease 的 pin → 显式配置的 `[subagent].default_model`；都没有则以 `model.not_configured` 失败且不创建子 Agent，调用方模型不是静默回退。在 profile、route 或 caller lease 中写 `model_alias: inherit` 才是显式跟随调用方已解析的模型，而 `AgentRun` 本身拒绝 `model_alias: "inherit"`，请写具体模型名或省略参数。配置为继承时思考强度也跟随调用方，除非工具 `effort` 或适用的 `thinking_effort` pin 优先；否则按工具 `effort` → route 上锁定的 effort（route 未锁定时改用 caller lease 的）→ 匹配的 `model_profiles` 档位 → 绑定模型与 profile pin 一致时的 `thinking_effort` → 绑定模型默认档位解析。都不提供时，能力明确不支持思考的模型使用 `off`；思考模型没有可解析默认档位时仍需显式选择。未知能力不视为 `off`，未知 alias 一律报错。

`resume` 时省略 `model_alias` 和 `effort` 保留已保存绑定，解析到同一规范模型的 alias 不产生变化；只改 `effort` 在下次空闲运行生效；换到不同规范模型需要 `allow_model_change: true`，此时省略 `effort` 会重新解析目标模型默认值而不沿用旧值。恢复准入会检查 profile、lease、model-profile 与继承的硬规则，拒绝时已保存绑定保持不变；provider 无法执行的 effort、机器级模型禁止和 executor thread 绑定限制同样是硬错误。

新建子 Agent 时省略 `model_alias` 和 `effort` 即使用目标默认值。模型目录按硬规则过滤，并单独标明来自有效 profile、lease、route 和 model-profile 的推荐；出现在其他目标下的模型在这里既不算推荐也不算允许。把 `preferred_models` 与默认 `model_alias` 一起声明可以发布推荐模型池，`model_profiles` 用来提供逐模型默认值和指引。route 的档位覆盖（包括 `service_tier: null`）不会清除模型级档位配置。

原生模型治理先解析 `[models]` alias，再按规范模型身份比较；外部 executor 使用实际生效模型 ID。`allowed_models`、`deny_models`、`allowed_efforts` 在任何作用域都是硬规则；`preferred_models`、`discouraged_models`、`preferred_efforts`、route 默认值和 caller lease pin 是软建议，偏离会保留在绑定中并在父侧 `AgentRun` 结果里摘要。字段与校验规则见[配置参考](../configuration/config-files.md#subagent)。

目录中发现的非法文件会被跳过并告警，不影响其他文件；通过 `--agent-file` 显式传入的文件必须合法，否则 CLI 报错退出。

::: warning 注意
`tools` 与 `disallowedTools` 决定模型能"看到"哪些工具，并在执行前再次强制检查。预设 allow / deny 规则也会过滤 `AgentRun` 的目录，并在派发前再次检查；`can_spawn_subagents: false` 禁止新建 Markdown 文件子 Agent，但恢复已有子 Agent 不受影响。需要审批的操作仍由权限规则单独控制。
:::

被派发的自定义 Agent 会收到一段简短的委派说明：最后一条消息就是交给调用方的完整交付。独立宿主调用（MCP / SDK）收到的是另一段（说明这里没有父 Agent），main agent 绑定则不注入。在正文里写 `${delegation_context}` 可指定它的位置，否则默认前置；设 `delegation_notice: off`（或在 `config.toml` 写 `[agents.delegation] sub = false` / `independent = false`）可以关闭。要改文案，通过 [`PromptOverrides`](../configuration/config-files.md#prompt) 覆写 `delegation.sub.notice` 或 `delegation.independent.notice`，布尔开关始终优先。

### 选择 main agent

两个 CLI flag 用于选择驱动新会话的 Agent，在 print 模式（`kiki -p`）和交互式 TUI 中均可使用：

- **`--agent <name>`**：以指定 Agent 作为 main agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。该 flag 只接受一个文件：不可重复传入，也不能与 `--agent` 同时使用。

两个 flag 只在新建会话时有效，都不能与 `--session`/`--continue` 组合。Agent 在创建时绑定，恢复会话会自动还原，因此恢复时不需要也不允许携带它们。

print 模式下显式 `--model` 优先于所选 profile 的 `model_alias`；省略 `--model` 时先用 profile 的 pin，只有 profile 未指定模型才用 `default_model`，因此钉死模型的 profile 无需全局默认值也能运行。subagent 不使用这个主 Agent 默认值，但可以用自己的 `[subagent].default_model`。main agent 没有调用方，即使设置了 `default_model` 或 `--model`，profile 也不能固定 `model_alias: inherit`。

例如：

```sh
kiki --agent reviewer
kiki -p --agent reviewer "审查这个分支上的改动"
```

这些 flag 只决定新建会话使用哪个 profile；GUI 可以在提交下一条消息时请求切换主档，同一 TUI 进程内之后新建的会话（例如 `/new`）使用默认 Agent。main agent 的选模以你为准，优先于 profile 规则：偏离推荐不警告，硬规则违规只显示非阻断提示。

定制 main agent 时，在正文中引用 `${parent_prompt}` 或 `${base_prompt}`，即可保留有效默认提示词里已有的环境、工作区指令、Skill 和 plugin 注入。`${builtin_prompt}` 始终是出厂默认，即使存在 `SYSTEM.md`；只想保留 plugin 指令时改用 `${plugin_sections}`。三者都不引用则完全拥有自己的提示词、不含 plugin 指令，适合自包含的 subagent。

### 用 SYSTEM.md 覆盖 main agent 的系统提示词

要永久替换默认 main agent、而不必每次启动都传 `--agent` 或 `--agent-file`，写一份 `$KIKI_HOME/SYSTEM.md`（默认 `~/.kiki/SYSTEM.md`，随 `KIKI_HOME` 移动）。它在包括交互式 TUI 会话在内的所有启动方式下生效。文件缺失或为空不做任何事；解析失败会给出带路径的诊断，同时该文件最后一次有效的版本继续可用，修复后重新加载即可恢复覆盖——开头为 `---` 的文件若 YAML 写错，不会被当作纯提示词重新解释。删除文件即移除覆盖。

解析方式取决于第一行：

- **遗留正文。** 文件不以 `---` 加 YAML mapping 开头。只替换提示词，描述、工具集和可委派的 subagent 列表沿用内置默认。
- **普通 profile。** 文件以 `---` 开头且围栏解析为 YAML mapping。按名为 `agent` 的普通 Agent 文件加载，`override` 强制为 `true`；未声明的工具字段和子角色权限继承内置默认，已声明的预设权限收窄它们，显式推荐替换继承的推荐。

显式意图仍然优先：项目作用域中声明 `override: true` 的同名 Agent 文件和 `--agent-file` 传入的文件排在它之前，`--agent` 选择其他 Agent 时它完全不生效；在用户作用域内部，SYSTEM.md 优先于 `agents/` 目录中扫描到的同名文件。

升级后的 `SYSTEM.md` 可以在 Frontmatter 中声明 `prompt_overrides`。设为 `system_prompt_mode: inherit` 时保持正文为空，Kiki 保留内置 `agent` 提示词并只应用这些字段。替换正文仍然是权威的，会遮蔽内置 `system.*` 段落覆写，而 `system.shared` 和适用的 delegation notice 留在正文之外。完整格式和优先级见 [`prompt`](../configuration/config-files.md#prompt)。

与普通 Agent 文件的正文一样，SYSTEM.md 每次构建提示词时作为模板渲染，正文中的 `${var}` 占位符会被替换为实时上下文：

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

另有四个预组合块——`${windows_notes}`、`${additional_dirs_section}`、`${skills_section}`、`${plugin_sections}`——渲染对应的内置提示词段落，不适用时为空字符串。内置默认提示词已经包含 `${plugin_sections}`，当 `${base_prompt}` 展开为该提示词时不要再重复加入。用这些变量可以重建内置提示词的骨架：

```markdown
You are Kiki, running at ${cwd} on ${os}.

${agents_md}

${skills}

${plugin_sections}
```

## 指令文件

`AGENTS.md` 在各自声明的目录作用域内提供指令，冲突时更具体的文件优先。它们从属于系统策略和你的当前请求，无法改变工具 schema、权限或宿主控制。

Kiki 会加载 `$KIKI_HOME/AGENTS.md`（默认 `~/.kiki/AGENTS.md`）和工作区根目录的 `AGENTS.md`；根目录的 `.kiki/AGENTS.md` 会替换用户级文件，根 `AGENTS.md` 仍然生效。会话启动时还会加载从项目根到工作目录这条路径上适用的文件，文件名匹配不区分大小写。项目边界之上、`~/.agents/AGENTS.md` 和旧的 `.kimi-code/AGENTS.md` 路径不会被发现。

获准的文件工具走到另一个目录时，Kiki 会检查该目录祖先中的 `AGENTS.md` 与 `.kiki/AGENTS.md`。如果某次写入本会漏掉这些规则，第一次写入会返回可重试结果且不修改任何文件，Agent 阅读规则后按同一权限策略重试即可，不需要额外审批。已由运行时快照或一次完整成功的 `Read` 交付过的规则不会因为别的工具再次访问该目录而重发，截断的读取不算完整。初始目录列表只是一层样本，Agent 会用 `Glob` 继续探索。

## 会话目录中的存储位置

subagent 的运行状态持久化在当前会话目录的 `agents/` 子目录下，每个实例一个目录，其中的 `wire.jsonl` 按时间顺序记录提示词、消息历史和最终状态；后台 subagent 还会在 `tasks/` 子目录暴露生命周期状态。

::: warning 注意
会话目录、wire 文件和任务记录可能包含提示词、命令输出、仓库路径、工具返回内容或凭证痕迹。放入公开仓库、issue 或聊天记录前请先脱敏。
:::

## 下一步

- [Hooks](./hooks.md) — 在 subagent 完成等关键节点触发本地脚本通知或拦截
- [Agent Skills](./skills.md) — 给 subagent 注入专业知识和工作流程
