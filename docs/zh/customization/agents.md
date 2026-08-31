# Agent 与 subagent

Kimi Code CLI 中的每次会话都由一个**main agent** 驱动。main agent 理解用户意图、规划步骤、调用工具，并在需要时向外派发**subagent** 处理更聚焦的子任务——例如探索一个陌生代码库、并行审阅多处实现、或在不触碰主上下文的情况下规划一次大型重构。

subagent 接受 main agent 给出的任务描述，在自己的独立上下文里工作，最后把结论返回。它不会与用户直接对话，中间的思考和工具调用记录也不会混入 main agent 的历史。

## 内置 subagent

Kimi Code CLI 内置三种 subagent，开箱即用，分别面向不同任务形态：

- **`coder`**：默认 subagent，通用软件工程助手，可以读写文件、执行命令、搜索代码并落地具体改动。
- **`explore`**：代码库探索专用，只做只读操作，不修改任何文件。适合在不改动文件的前提下快速搜索、阅读和总结仓库。
- **`plan`**：实现规划与架构设计专用，连 Shell 命令都不提供，专注于"想清楚怎么做"而不是"动手做"。

`coder` subagent 与 main agent 共享大部分工具集：可以在后台执行 Shell 命令、维护待办列表、进入 Plan 模式、调用 Agent Skills，也可以用 `TaskWait` 等待后台任务。它没有 `AgentRun`、`AgentSwarm`、`AgentList` 或 `AgentSend`；要嵌套派发，需要在自定义 profile 里显式列出这些工具。如果它结束自己的轮次时仍有后台任务在运行，那么只有在这些后台任务全部落定后，这次运行才会回报完成——main agent 拿到结果时，背后的工作也已经真正完成。

顶层配置 [`disabled_builtin_profiles`](../configuration/config-files.md#顶层字段) 会从 subagent 发现与派发列表中移除指定的内置 profile（`agent`、`coder`、`explore` 或 `plan`）。禁用 `agent` 不会影响 main agent 使用默认绑定启动；文件 profile 与已禁用内置 profile 同名时，不再需要 `override: true`。

## 调用方式

subagent 由 main agent 自动调度——根据任务复杂度、上下文消耗和子任务的独立性，在适当时机派发，无需用户手动指定。

每次派发都会在终端以审批请求的形式呈现（除非命中 allow 规则或处于 YOLO 模式），方便你审视任务描述。你也可以在对话中直接指示 main agent 使用特定 subagent，例如"先用 explore 把相关文件梳理一遍再动手"。

subagent 支持在后台运行：完成后结果自动回到 main agent，无需手动轮询。也可以唤回已有的 subagent 实例继续推进同一任务。

## 具名子 Agent {#codex-风格协作适配器}

默认的 v2 引擎（Kiki 桌面端和 `kimi` CLI/TUI）会给主 `agent` profile 提供四个子 Agent 工具，不需要实验开关：`AgentRun`、`AgentSwarm`、`AgentList` 和 `AgentSend`。内置的 `coder` 与 `explore` profile 没有它们。每个调用方只能列出和发消息给自己直接创建的子 Agent；孙级或别人创建的子 Agent 都不是有效目标。

`AgentRun` 用来启动新的子 Agent，或继续已有的。每次调用都必须提供 `prompt` 和用于界面展示、长度为 3–5 个词的短 `description`。新派生还可以设置 `profile`（默认 `coder`）、`route`、`name`、`background`、`model_alias` 和 `effort`。预计之后还要再找同一个子 Agent 时传入 `name`；名称必须匹配 `^[a-z0-9_]+$`，不能是 `root`，并且在会话内保持唯一。继续直属子 Agent 时，把 `resume` 设为它的名称或 agent id，并沿用已持久化的 profile、route、模型和 effort 绑定。

`AgentSwarm` 从包含 `{{item}}` 的 `prompt_template` 与最多 128 个值的 `items` 数组启动基于 item 的子 Agent。它必须提供 `description`；新派生项还可以设置 `profile`（默认 `coder`）、`route`、`model_alias` 和 `effort`。它也可以通过 `resume_agent_ids` 继续直属子 Agent。

`AgentList` 返回这些直属子 Agent，也包括 swarm 成员。默认 `include_finished=false` 列出运行中的，以及没有跟踪任务的；需要已经结束或失败的，再传 `true`。最多返回 50 条，运行中的排在前面。

`AgentSend` 把消息排进邮箱，不会启动或中断 turn。空闲的子 Agent 会保持空闲，到下一步开始时才读这条消息。用 `name` 或 agent id 指定目标。

已移除的 v1 Codex 风格协作适配器及其实验开关不适用于 v2 引擎。

## Peer thread 通信

Peer thread 通信让主 Agent 协调同一台本地主机上的现有 Kimi Code 会话，也可以跨工作区通信。它与上面的子 Agent 工具相互独立，并且默认关闭。选择启用后，`list_threads`、`read_thread`、`send_message_to_thread` 和 `wait_threads` 这 4 个工具只提供给会话的主 Agent，不提供给子 Agent。

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

subagent 的权限规则继承自 main agent：main agent 通过 `/permission` 或在审批中接受的"始终允许"规则，会自动覆盖到它派发出的所有 subagent，subagent 不需要重新审批同类工具调用。`AgentRun` 工具本身默认放行，因此 main agent 可以在不打断用户的前提下完成多次委派。

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

用户、项目和 `extra_agent_dirs` 根目录下的 Agent Markdown 文件都会被文件系统监听。新增、修改或删除后，经过约 200 ms 去抖会自动重载，因此运行中的会话无需执行 `/reload` 或重启 CLI，就能派发新出现的角色。`$KIMI_CODE_HOME/SYSTEM.md` 也以相同方式监听。已经创建的 `AgentRun` 工具实例会保留角色描述列表的冻结快照，因此展示可能暂时滞后，但实际派发会立即使用重载后的 profile。

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
| `main` | 否 | 策展标记。为 `true` 时该 profile 可作为 main agent 候选，默认不出现在 `AgentRun` 工具的角色列表里。这不是授权门：`--agent`、`--agent-file`、MCP 和 SDK 仍可按名绑定目录中的任意 profile |
| `delegation_notice` | 否 | `auto`（默认）在该 profile 作为 subagent 或独立宿主 Agent 运行时注入按位置区分的委派说明；`off` 关闭。main agent 绑定从不注入 |
| `model_alias` | 否 | `[models]` 中区分大小写的精确 alias。它就是该 profile 的模型 pin：派发未指定模型时绑定它；没有它的 profile 只能由显式 `model_alias` 的派发使用 |
| `thinking_effort` | 否 | 该 profile 作为新子 Agent 启动时请求的 thinking effort，与模型选择器独立解析 |
| `allowed_models` | 否 | 该 role 允许绑定的模型 alias 白名单。写法与 `tools` 相同（YAML 列表或逗号分隔字符串）。字段存在且非空时，绑定结果必须是其中一员。比较走规范模型身份，因此裸 alias 与带 provider 前缀的名字可以互相匹配。这份名单只能**收紧**机器已经允许的集合，不能重新放行 `[subagent].deny_models` 或本文件 `deny_models` 禁止的模型。只写一项就是把该 role 钉死到那个 alias 的做法，不必再为“只改模型”单独建 route sidecar。省略字段或写成空列表表示不再额外限制 |
| `deny_models` | 否 | 该 role 禁止绑定的模型 alias 名单，写法与 `allowed_models` 相同。自动派发会被拒绝；人类显式选择放行并给一次性提示。机器级 `[subagent].deny_models` 仍拒绝所有路径，包括人类 |
| `allowed_efforts` | 否 | 该 role 允许的 thinking effort 白名单，写法与 `tools` 相同。角色级与匹配到的 `model_profiles` 条目求交。自动派发（`AgentRun` / `AgentSwarm`）超出交集即拒绝；人类显式选择放行并给一次性提示 |
| `model_profiles` | 否 | 该角色在某个模型上的跑法。只支持 YAML mapping 列表。必填 `alias` 与 `when`；可选 `thinking_effort`、`allowed_efforts`、`prompt_mode`（`prepend` / `append` / `wrap`）和 `prompt`。`when` 只给派发方看，渲进 `AgentRun` 工具说明，不写进子 Agent 自己的提示词。带 `prompt_mode` 的条目在角色正文之后、模型 cognition overlay 之前组合；`wrap` 要求正文恰好一次 `${parent_prompt}`（或其别名 `${base_prompt}`）。本机 `[models]` 表解析不到的 alias 既不出现在工具说明里，也不生效。重复 alias 会全部保留在文件里，overlay 只匹配第一条解析成功的。旧键 `recommended_models` 仍接受为弃用别名并在加载期 warn；两键同时出现时 `model_profiles` 胜 |
| `service_tier` | 否 | 该 profile 作为子 Agent 运行时每个 LLM 请求携带的服务档位：`auto`、`default`、`flex` 或 `priority`。目前只有 `openai_responses` 协议会把它编码进请求体，其他协议静默忽略 |
| `request_params` | 否 | 附加请求参数，标量 map（值只允许字符串 / 数字 / 布尔值），该子 Agent 的每个请求都会携带。OpenAI 系协议展开进请求体（Kimi 经 `extra_body`），不会覆盖引擎生成的字段；Anthropic 协议静默忽略；与 `service_tier` 等一等字段冲突时一等字段优先。键名原样发送，provider 可能拒绝它不认识的键 |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。支持 YAML 列表或逗号分隔字符串（`tools: Read, Grep`）两种写法。缺省表示允许全部工具；单独的 `*` 同样表示允许全部工具；空列表（`tools: []`）表示禁用全部工具 |
| `disallowedTools` | 否 | 禁止列表，写法与匹配规则相同，在 `tools` 之后应用 |
| `subagents` | 否 | 允许委派的子 Agent 名称列表，写法与 `tools` 相同（YAML 列表或逗号分隔字符串）。省略字段或单独写 `*` 表示不限制；空列表（`subagents: []`）表示禁止派发任何子 Agent；其他显式名称构成白名单 |

`model_profiles` 是一个 YAML mapping 列表。顶层写成字符串、标量或单个 mapping 都是非法的，因为每个条目都需要 `when` 触发条件。示例：

```yaml
model_profiles:
  - alias: fast-model
    when: 范围与验收标准已经明确，快速给出结论比等待更划算。
    thinking_effort: high
  - alias: k3-review
    when: 默认 alias 自己就能完成的常规评审。
    prompt_mode: prepend
    prompt: |
      优先做系统级与全局契约推理。
```

`allowed_models` 与 `deny_models` 只能收紧，不能放宽。机器级 `[subagent].deny_models` 始终优先，即使 role 的白名单里写了同一个 alias。只含一项的 `allowed_models` 用来把该 role 钉死到一个模型；route sidecar 不能声明这两个字段。

```yaml
allowed_models:
  - fast-model
  - k3-review
deny_models:
  - heavy-model
```

```yaml
# 把该 role 钉死到一个 alias：
allowed_models: [fast-model]
```

写白名单时要同时写上你想钉死的 `model_alias`。只声明 `allowed_models` 而不写 `model_alias` 的 profile 仍会加载并给出告警，但派发时若没有指定模型会直接 fail closed，而不是退到某个还要由白名单再判一次的默认模型。

内置工具与用户工具按名称精确匹配（区分大小写）；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。有三种写法永远匹配不到任何工具，在 profile 生效时会给出警告：`mcp__` 模式之外使用通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）；不是完整 `mcp__<服务器>__<工具>` 形式的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具 —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建提示词时都会作为模板渲染：`${var}` 占位符替换为实时上下文值——未知变量保持原样，单独的 `$` 没有特殊含义，上下文中缺失的变量渲染为空字符串。`${parent_prompt}`（别名 `${base_prompt}`）嵌入这份文件的隐式父提示词：Agent 文件里是有效默认提示词，`SYSTEM.md` 里是内置默认，route 里是基础 profile。`${builtin_prompt}` 始终是内置默认，即使存在 `SYSTEM.md`。如果文件会替换默认提示词、但仍要保留已启用 plugin 提供的指令，请把 `${plugin_sections}` 放在希望出现这些指令的位置。可用变量见下文 SYSTEM.md 变量表。

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

必填字段为 `id`、`profile`、`description` 和 `prompt_mode`。可选字段为 `whenToUse`、`model_alias`、`thinking_effort`、`service_tier`、`request_params`、`tools`、`disallowedTools`、`subagents`。与普通 Agent 文件不同，route Frontmatter 使用严格解析。未知字段、非法类型、路径 / ID / profile 不匹配、同一来源内重复 ID、互斥的模型选择器只会让该 sidecar 被跳过并产生带 code 的诊断；基础 profile 和其他 route 仍会加载。`recommended_models`、`model_profiles`、`allowed_models`、`deny_models` 等仅属于 Agent 文件的字段在这里属于未知字段，会导致该 sidecar 被跳过。Route 可以钉死 `model_alias`，但该钉死值仍要接受基础 profile 的 `allowed_models` / `deny_models` 检查。

`prompt_mode` 始终保留基础提示词：`inherit` 要求正文为空；`prepend` 与 `append` 要求正文非空且不能包含 `${parent_prompt}` / `${base_prompt}`；`wrap` 要求正文必须且只能包含一次 `${parent_prompt}` 或 `${base_prompt}`。不提供无保护的 replace 模式。

Route 若声明 `tools`、`disallowedTools` 或 `subagents`，该字段整体替换基础值；省略则继承基础。`subagents: []` 会让 route 成为叶子。调用方检查仍针对基础 role，因此 route 不能引入调用方原本不能派发的 role。需要另一个 role 身份时，应新建并 allowlist 一个基础 profile。

请求字段省略时继承基础值。`service_tier: null` 清除基础 tier，其他值直接替换；`request_params: null` 清除基础 map，传入 map 时按标量 key 覆盖。Route 声明的 `model_alias` 或 `thinking_effort` 对自动派发锁定：`AgentRun` / `AgentSwarm` 可以省略或重复同一值，冲突值会被拒绝。锁定的 alias 不存在时会在分配 Agent 之前报错，不会走普通 profile alias 的回退逻辑；所选模型无法精确执行锁定 effort 时，派发同样会失败。已经绑定的会话里，人类显式 `/model` 或切换 effort 会放行并给一次性提示，快照上的锁仍在。

启用后，`AgentRun` 与 `AgentSwarm` 都会列出经调用方基础 role allowlist 过滤后的精简 route 条目。条目只包含 route ID、基础 role、描述 / 使用提示、模型与 effort 默认值、被覆盖的字段名，绝不包含提示词正文。调用时传入 `route: reviewer.ui-k3`；可以省略 `profile` 让系统推导 `reviewer`，也可以显式传入这个匹配的基础 role。Role 不匹配会产生带 code 的错误。系统不会自动排序选择或静默回退。

恢复时不会重新选择或切换 route。Journal 会保存规范基础 role、route ID、渲染后的提示词、分层工具策略、denylist、子 Agent 限制、模型 / effort 锁、service tier 与请求参数。因此，即使后来关闭 flag，或 sidecar 被修改、删除、写坏，已有 routed Agent 仍从快照恢复；这些变化只影响新派发。旧 journal 继续兼容。混合 `AgentSwarm` 调用只把 `route` 应用于基于 item 的新 Agent，resume 条目保留原快照。

新派生子 Agent 的模型只有两个来源：工具参数 `model_alias`，或生效 profile / route / caller lease 上的 `model_alias` pin；两者都在时以派发参数为准。两者都没有时派发以 `model.not_configured` 失败，子 Agent 不会被创建——子 Agent 不会跑在调用方的模型上，也没有可回退的配置默认值。effort 独立解析且允许留空：工具 `effort` → profile `thinking_effort` → 所绑定模型自身的默认档位。未知 alias 无论来自派发参数还是 profile pin 都会报错。

恢复或重试的子 Agent 保持已持久化的模型与 effort；`AgentRun` 用 `resume` 继续时传入绑定字段会被拒绝。`AgentSwarm` 混合调用只把这些字段应用到基于 item 的新派生项。

subagent 模型治理会先解析 `[models]` alias，再按规范模型身份比较。机器级 `[subagent] deny_models` 在所有派发入口拒绝名单内的模型。role 文件可以用 `allowed_models` 与 `deny_models` 再收紧这个集合；它们不能放宽机器已经禁止的模型，只含一项的 `allowed_models` 就是该 role 的硬钉死。字段与校验规则见[配置参考](../configuration/config-files.md#subagent)。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。`subagents` 同样双重生效：`AgentRun` 工具的类型列表只包含允许委派的 subagent，`AgentRun` 与 `AgentSwarm` 在实际派发前都会强制校验；继续已有 subagent 不受此限制。权限规则仍是独立的控制层，用于决定哪些操作需要审批。
:::

自定义 Agent 作为被派发的 subagent 运行时，Kimi 会注入一段简短的委派说明：最后一条消息就是交给调用方的完整交付。独立宿主调用（MCP / SDK）用另一段说明：没有父 Agent。main agent 绑定不注入。在正文里写 `${delegation_context}` 可指定位置，否则前置。profile 上设 `delegation_notice: off`，或在 `config.toml` 写 `[agents.delegation] sub = false` / `independent = false`，即可关闭。配置了路径就必须存在且非空，否则 bind 失败。

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

定制 main agent 时，在正文中引用 `${parent_prompt}` 或 `${base_prompt}` 可保持有效默认提示词中已有的环境、工作区指令、Skill 和 plugin 注入生效。`${builtin_prompt}` 始终是出厂默认提示词，即使存在 `SYSTEM.md`。如果要替换默认提示词、但只保留 plugin 提供的指令，请改用 `${plugin_sections}`。正文同时不引用 `${parent_prompt}` / `${base_prompt}` 和 `${plugin_sections}` 时，会完全拥有自己的提示词并排除 plugin 指令，适合自包含的 subagent。

### 用 SYSTEM.md 覆盖 main agent 的系统提示词

希望永久覆盖默认 main agent、而不必每次启动都传入 `--agent` 或 `--agent-file` 时，可以写一份 `$KIMI_CODE_HOME/SYSTEM.md`（默认：`~/.kimi-code/SYSTEM.md`，随 `KIMI_CODE_HOME` 移动）。文件缺失或为空时不生效；读取失败时会告警并回退到内置提示词。SYSTEM.md 在包括交互式 TUI 会话在内的所有启动方式下生效。

解析方式看文件第一行：

- **遗留正文。** 文件并非以 `---` 加 YAML mapping 开头。只替换提示词；描述、工具集与允许委派的 subagent 列表仍沿用内置默认。不需要也不读取 Frontmatter。
- **普通 profile。** 文件以 `---` 开头，且围栏解析为 YAML mapping。按名为 `agent` 的普通 Agent 文件加载，`override` 强制为 `true`。未声明的 `tools` / `disallowedTools` / `subagents` 仍沿用内置默认；声明了的字段生效。

优先级上，显式意图仍然胜出：项目作用域中声明了 `override: true` 的同名 Agent 文件、通过 `--agent-file` 传入的文件都排在 SYSTEM.md 之前，用 `--agent` 选择其他 Agent 时 SYSTEM.md 也不会生效；而在用户作用域内部，SYSTEM.md 优先于 `agents/` 目录中扫描到的同名文件。

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
