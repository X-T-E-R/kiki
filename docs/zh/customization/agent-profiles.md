# Agent profile 概念与设计

Kiki 里每个 agent（包括 main agent 和每个 subagent）都由一份 **profile** 定义。本页解释 profile 是什么、文件放在哪里、什么时候生效，以及它和其他定制机制（Skill、prompt 字段覆写、plugin、hook、主题）的分工。具体字段与用法见 [Agent 与 subagent](./agents.md)。

## Profile 是什么

一份 profile 就是一个 Markdown 文件：顶部的 **Frontmatter**（YAML 元数据块）声明名字、描述、工具白名单、模型绑定等，正文就是这个 agent 的**系统提示词**。

在输入区直接选中的 profile 文件是只作用于本次会话的来源，不会进入发现目录；控件与恢复方式见[选择引擎与它的 profile](./agents.md#选择引擎与它的-profile)。

Kiki 内置了几份 profile：驱动会话的 main `agent`、默认 subagent `general`、只读探索用的 `explore`。自定义 agent 不需要写代码——照这个样子写一份 Markdown 文件，就会被自动发现，与内置 profile 并列。

## 文件放在哪里

Kiki 按作用域发现 profile 文件，作用域越具体，优先级越高：

**显式指定（`--agent-file`）> 项目级 > 额外目录 > 用户级 > 内置副本 > plugin**

两个文件定义了相同的 `name` 时，高优先级作用域的文件胜出——例外是声明了 `system_prompt_mode: inherit` 的文件，它保留下层同名 profile 的定义、只应用自己的字段覆写。常用位置（`$KIKI_HOME` 默认为 `~/.kiki`）：

- **项目级**（只对这个仓库生效）：`<项目根>/.kiki/agents/`、`<项目根>/.agents/agents/`
- **用户级**（对所有项目生效）：`$KIKI_HOME/agents/`、`~/.agents/agents/`
- **内置副本**：随安装写入 `$KIKI_HOME/agents/builtin/`，同名用户文件天然优先于它

::: warning 注意
项目级 profile 来自仓库本身——包括你刚 clone、还不信任的仓库。一份名为 `agent.md` 的项目文件可以替换默认 main agent 的整个系统提示词。在陌生仓库里运行 Kiki 前，像审查脚本一样检查它的 `.kiki/agents/` 目录。
:::

完整的作用域规则与目录列表见 [Agent 目录](./agents.md#agent-目录)。

## 修改什么时候生效

用户级、项目级和额外目录根下的 profile 文件，以及 `$KIKI_HOME/SYSTEM.md`，都被监听：新增、修改、删除后约 200 ms 自动重载，之后新派发的 subagent 立即用上新版本。已有会话的 main agent 仍绑定创建时的快照，改完文件后在会话里执行「重建上下文」即可换上新版本，对话记录保留。详见 [重建会话上下文](./agents.md#重建会话上下文)。

## Main agent 与 subagent

一次会话由一个 **main agent** 驱动；它可以派发 **subagent** 处理聚焦的子任务。两者用同一套 profile 文件格式，区别在于使用方式：

- **main agent**：启动会话时用 `--agent <名字>` 或 `--agent-file <路径>` 指定，或在 GUI 的 profile 选择器中切换。Frontmatter 里 `main: true` 的 profile 会出现在 main agent 候选里。
- **subagent**：由 main agent 在对话中自动派发，拥有独立上下文，只把最终结论带回。你也可以直接要求"用 explore 先梳理一遍"来指定。

`prompt_overrides` 和各 `model_profiles` 条目里的正文都可以按 Agent 实际所处的身份分支：省略或写 `same` 使用共用声明，写 `off` 停用该声明，写对象则为该身份整组替换。Subagent 使用共用声明。这些分支只影响提示词，不改变选模或权限；顶层 `main: true` 仍只是标记 main agent 候选。[模型 cognition](../configuration/config-files.md#models) 的 overlay、steering 和 anchor 文件按同一规则选择。

```yaml
model_profiles:
  - alias: review-model
    prompt_mode: append
    prompt: 先检查证据，再形成结论。
    main:
      prompt_mode: append
      prompt: 统筹工作，向用户交付已验证的结果。
    independent: off
prompt_overrides:
  fields:
    system.shared: 清楚说明发现。
  main:
    fields:
      system.shared: 向用户简洁说明结果和下一步。
```

两个对象各自替换：`main` 正文替换共用的 `prompt_mode` / `prompt` 对，`main` 字段对象替换该声明的文件和字段。对象里请写全你仍然需要的共用内容。身份由实际绑定决定，不看 profile 名字或 `main: true`；外部委派的 Agent 使用 `independent`。

档案作为 subagent 运行时，在自己的 `tools` 与 `disallowedTools` 之外还有一层：部分工具对 subagent 默认关闭，需要点名才开放，例如 `ThreadRead`、`AskUserQuestion` 和 `Cron`。在 `tools` 中点名一个，只为该档案作为 subagent 时开放它，不影响其他。把通配符写在名字旁边，普通工具照常可用：

```yaml
tools: ["*", ThreadRead]
```

只写 `*` 不会开放任何 opt-in，也不会穿过任何 deny；有限名单仍然有限，`tools: [Read, Grep, ThreadRead]` 就只选这三个。服务端 `subagent.allowed_tools` 与在这里点名是「或」的关系，但档案仍需自己选中该工具才会开放——这就是上面 `["*", ThreadRead]` 写法的用途。没写名单（或写了 `*`）的档案对这一项放行的工具都开放，本档案自己的 `disallowedTools` 仍能禁用。主对话不受这些 opt-in 限制，能选哪些工具仍由同一档案的名单决定。完整清单见 [subagent 默认限制](../configuration/config-files.md#subagent)。

想让默认 main agent 永久换成自己的配置，用这一个特例文件：`$KIKI_HOME/SYSTEM.md`（默认 `~/.kiki/SYSTEM.md`）。纯正文的 `SYSTEM.md` 只替换默认 main agent 的系统提示词；以 `---` Frontmatter 开头的还能同时改 `tools`、`subagents`、模型绑定等 profile 字段。见 [用 SYSTEM.md 覆盖 main agent 的系统提示词](./agents.md#用-system-md-覆盖-main-agent-的系统提示词)。

## 模型菜单与硬边界

`model_profiles` 为不同模型提供参数与提示词。默认情况下它只是候选菜单，不是唯一获准的模型清单。Frontmatter 字段 `restrict_models_to_menu` 只接受布尔值，默认 `false`；设为 `true` 后，菜单成为 subagent 绑定的契约，只允许声明的默认 `model_alias` 和 `model_profiles[].alias`。它适用于 main agent、subagent、注册 profile 与显式 profile 文件，不适用于 route、caller lease（调用方给子 Agent 的配置）、`spawn_constraints` 或菜单条目；父 profile 开启不会自动传给子 profile。

要表达完整的获准集合，维护一份正向名单即可，不必再抄进 `allowed_models`：

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: 需要更深入的评审。
    thinking_effort: high
```

这份菜单包含 `fast-model` 和 `review-model`，默认模型不必再写一个空条目。模型按执行器的规范身份比较，不看 alias 尾缀。换默认模型也会改变菜单：旧默认若未单独列在 `model_profiles` 中，替换后它就不再获准。

开关增加一层硬允许域。它不改变选模优先级，也不会自动选菜单第一项。Kiki 在按目录与作用域选定 profile 后捕获原始默认和菜单并随绑定冻结，因此显式派发参数、route / lease pin、已保存的实际模型，以及替换了 `model_profiles` 的 lease 都无法放宽它；把条目换成子集或空列表也不会收窄冻结的菜单——额外的硬限制请用 `allowed_models`。

caller lease 提供 `model_profiles` 时会替换 child 的菜单和参数默认值，但默认保留原角色的模型提示词（`model_prompts: preserve`）：Kiki 按 child 的最终 alias 匹配两层来源，先应用角色正文再应用 lease 正文，字段也按此顺序合并。`model_prompts: replace` 只丢弃原提示词，冻结的菜单和硬规则仍在。lease 只作用于 child，因此它自身的模型正文和字段声明不能包含 `main`、`independent` 分支。

会话的 **main agent** 以你的选模为准，优先于 profile 约束。偏离推荐或默认 pin 不产生警告，超出硬域也只显示非阻断提示；GUI 保留已配置模型的可选性，不会因此拒发。模型存在性与 provider / executor 能力照常校验。通过 `AgentRun` 派遣的 `main: true` profile 仍是 subagent，不是 main 会话。

**subagent 绑定**在 GUI、CLI、`AgentRun` 和 API 中规则一致：

- **菜单外拒绝，不降级。** 显式选择菜单外模型返回 `profile.constraint_violation`，不会回落到默认。省略模型时仍按既有默认规则选模再校验，若选中的模型在菜单外则拒绝绑定，而不是换成菜单里的其他条目。
- **其他硬规则照常生效。** 菜单与各层 `allowed_models` 求交，`deny_models` 命中始终拒绝，`"*"` 不能放宽菜单。菜单与某条 `allowed_models` 完全相同只是冗余，不是错误；不同时仍求交，两层都不会被忽略。
- **`when` 是提示不是门禁。** 它是给调用方看的文字，不做条件判断，缺失或看似不满足都不影响许可。`preferred_*` 与 `discouraged_models` 仍只是建议，菜单顺序也不是降级链。
- **空集合什么都不允许。** 空菜单加默认会限制为那一个模型；两者都没有、没有有效候选，或与其他硬域交集为空时，绑定被拒绝。
- **恢复不会扩权。** `resume` 重新校验冻结的菜单、已保存的硬规则和当前调用方 / 机器规则，拒绝时已保存的绑定保持不变。换模型仍需 `allow_model_change: true`，但它不授权走出菜单。改磁盘上的文件不会改写已有快照：新绑定用新定义，已有会话需要显式重新绑定或新建会话。

Subagent 被硬拒绝时，选一个同时满足其他硬规则的菜单项，或修改 profile 声明；pin、人工选择和换模确认都不是绕过菜单的方式。

### 何时开启

`model_profiles` 已经是完整获准集合的 profile 适合开启；通用 profile 或只列几个示例的菜单保持关闭。

| 你想表达什么 | 配置 |
| --- | --- |
| 默认模型与菜单条目就是全部获准候选，带逐模型参数或提示，GUI 与调用方共用一份 | 开启 `restrict_models_to_menu`，不必再写等价的 `allowed_models` |
| 只是成本、速度或经验上的建议，希望用户仍能试菜单外的模型 | 保持关闭，使用 `preferred_models`、`preferred_efforts` 或 `discouraged_models` |
| 真正边界来自预算、合规、部署或下级树策略，与菜单无关 | 单独使用 `allowed_models` / `deny_models`；确实还要约束菜单时再叠加开关 |

字段参考与更多示例见 [Agent 文件格式](./agents.md#agent-文件格式)。

## 定制机制地图

下面的机制各管一件事。先确定想改什么，再选：

| 想改什么 | 用什么 |
| --- | --- |
| 跨会话复用的身份与私有记忆 | [角色、Bot 与房间](./personas.md) |
| Agent 的执行指令、可用工具、权限、模型 | **Profile 文件**（本页与 [Agent 与 subagent](./agents.md)） |
| 内置提示词里的一段具名文本（语言要求、工具描述） | [Prompt 字段覆写](./prompt-fields.md) |
| Agent 在需要时自动调用的专业知识或工作流 | [Agent Skills](./skills.md) |
| 自己用 `/名字` 触发的提示片段 | [提示命令](./skills.md#自定义提示命令) |
| 把 profile、Skill、命令、hook 打包分发给团队 | [Plugins](./plugins.md) |
| 在工具调用、会话事件上做出反应 | [Hooks](./hooks.md) |
| 终端界面配色 | [自定义主题](./themes.md) |

## 下一步

- [Agent 与 subagent](./agents.md) — profile 字段参考、派发方式、SYSTEM.md 与运行时行为
- [Agent Skills](./skills.md) — 给 agent 注入可复用的工作流
