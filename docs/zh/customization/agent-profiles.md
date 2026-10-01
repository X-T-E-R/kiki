# Agent profile 概念与设计

Kiki 里每个 agent（包括 main agent 和每个 subagent）都由一份 **profile** 定义。本页解释 profile 是什么、文件放在哪里、什么时候生效，以及它和其他定制机制（Skill、prompt 字段覆写、plugin、hook、主题）的分工。具体字段与用法见 [Agent 与 subagent](./agents.md)。

## Profile 是什么

一份 profile 就是一个 Markdown 文件：

- 文件顶部的 **Frontmatter**（YAML 元数据块）声明名字、描述、工具白名单、模型绑定等；
- 文件正文就是这个 agent 的**系统提示词**。

Kiki 内置了几份 profile：驱动会话的 main `agent`、默认 subagent `general`、只读探索用的 `explore`（旧安装还可能保留 `coder`、`plan`）。自定义 agent 不需要写代码——照样子写一份自己的 Markdown 文件，就会被自动发现，与内置 profile 并列使用。

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

用户级、项目级和额外目录根下的 profile 文件，以及 `$KIKI_HOME/SYSTEM.md`，都被文件系统监听：新增、修改、删除后约 200 ms 自动重载，无需重启——之后新派发的 subagent 立即使用重载后的版本。已有会话的 main agent 在创建时绑定了当时的 profile 快照；改动文件后，在会话里执行「重建上下文」即可让当前会话换上新版本，对话消息保留。详见 [重建会话上下文](./agents.md#重建会话上下文)。

## Main agent 与 subagent

一次会话由一个 **main agent** 驱动；它可以派发 **subagent** 处理聚焦的子任务。两者用同一套 profile 文件格式，区别在于使用方式：

- **main agent**：启动会话时用 `--agent <名字>` 或 `--agent-file <路径>` 指定，或在 GUI 的 profile 选择器中切换。Frontmatter 里 `main: true` 的 profile 会出现在 main agent 候选里。
- **subagent**：由 main agent 在对话中自动派发，拥有独立上下文，只把最终结论带回。你也可以直接要求"用 explore 先梳理一遍"来指定。

想让默认 main agent 永久换成自己的配置，还有一种特例文件：`$KIKI_HOME/SYSTEM.md`（默认 `~/.kiki/SYSTEM.md`）。纯正文的 `SYSTEM.md` 只替换默认 main agent 的系统提示词；以 `---` Frontmatter 开头的升级版还能同时改 `tools`、`subagents`、模型绑定等 profile 字段。优先级交互见 [用 SYSTEM.md 覆盖 main agent 的系统提示词](./agents.md#用-system-md-覆盖-main-agent-的系统提示词)。

## 模型菜单与硬边界

`model_profiles` 可以为不同模型提供参数与提示词；默认情况下，它只是候选菜单，不是全部获准模型的穷举。顶层 Frontmatter 字段 `restrict_models_to_menu` 只接受布尔值，默认 `false`。设为 `true` 后，菜单成为该 profile 的模型绑定契约：只允许作者声明的默认 `model_alias` 与 `model_profiles[].alias`，并继续受其他硬规则和执行器能力限制。它适用于 main agent、subagent、注册 profile 与显式 profile 文件，不放在 route、caller lease（调用方给子 Agent 的配置覆写）、`spawn_constraints` 或菜单条目里；父 profile 开启也不会自动替子 profile 开启。

例如，完整获准菜单可以只维护一份正向名单，不必再复制到 `allowed_models`：

```yaml
model_alias: fast-model
restrict_models_to_menu: true
model_profiles:
  - alias: review-model
    when: 需要更深入的评审。
    thinking_effort: high
```

这里的菜单包含 `fast-model` 和 `review-model`；默认模型不必重复写成一个空条目。模型按执行器使用的规范身份比较，不靠 alias 的字符串尾段匹配；无法解析或执行的声明不会因此获得运行能力。修改默认模型也会改变菜单：若旧默认没有单独列在 `model_profiles` 中，换默认就会移除旧模型并加入新模型。

开关只增加一层**硬允许域**，不改变选模优先级，也不自动选菜单第一项。Kiki 在按目录与作用域选定 profile 后、route 与 lease 改写前捕获原始默认和菜单，并随绑定冻结。显式派发参数、route / lease pin（默认模型指定）、已保存的实际模型，或 lease 替换的 `model_profiles` 都不能扩充它；lease 把条目替换为子集或空列表也不会抹除或收窄原菜单，另加硬限制应使用 `allowed_models`。原菜单条目的硬规则仍保留。

以下规则在 GUI、CLI、`AgentRun` 与 API 中一致：

- **菜单外拒绝，不降级。** 开启后，显式选菜单外模型返回 `profile.constraint_violation`，不回落到默认。省略模型参数仍先按既有默认规则选模，再校验菜单；若默认或配置回退在菜单外则拒绝，不扫描菜单找替代。没有选出模型仍报未绑定。
- **所有硬域同时生效。** 菜单与各层 `allowed_models` 求交，`deny_models` 命中始终拒绝；`"*"` 不能放宽菜单。机器级禁止与模型 / effort 能力限制仍按原有范围生效。关闭开关也不会撤销这些硬规则或菜单条目内部的硬规则。菜单与 `allowed_models` 完全等价时只是冗余，不是加载错误；两者不同时仍求交，不忽略任何一层。
- **提示不是门禁。** `when` 是供调用方阅读的提示，不执行条件判断；缺省、条件看似未满足或多个条件同时满足都不影响许可。`preferred_*` 与 `discouraged_models` 仍是软建议，不因开启菜单而变成硬规则；菜单顺序也不是降级链。
- **空域不放行。** 菜单为空但有默认时形成单模型限制；菜单与默认都没有、无法形成有效候选，或与其他硬域的有效交集为空时，拒绝绑定，而不是把空集当不限（fail closed）。
- **恢复不扩权。** `resume` 校验冻结的菜单与保存的硬规则，以及适用的当前调用方 / 机器硬域；违规时保留已保存绑定。换模仍须满足 `allow_model_change: true`，该确认不授权越过菜单。磁盘上改开关或菜单不会悄悄改写已有快照；新绑定使用新定义，已有会话需明确重新绑定或新建。

遇到硬拒绝时，选择仍满足其他硬规则的有效菜单项，或修改 profile 声明；显式 pin、人工选择与换模确认都不是绕过菜单的方法。

### 何时开启

优先为**已经把 `model_profiles` 维护成完整获准菜单**的 profile 开启；普通通用 profile 或只列几个示例的菜单继续关闭。Kiki 不会批量替现有 profile 开启或自动迁移它们。按意图选择：

| 场景 | 推荐写法 |
| --- | --- |
| 默认模型与菜单条目就是全部获准候选，需要逐模型参数 / 提示，并让 GUI 与调用方共用一份候选事实 | 开启 `restrict_models_to_menu`，维护默认与 `model_profiles`；通常不再手抄等价的 `allowed_models` |
| 只是成本、速度或经验推荐，仍希望人工或调用方尝试菜单外模型 | 保持关闭，使用软字段 `preferred_models`、`preferred_efforts` / `discouraged_models` |
| 真正边界来自预算、合规、部署或下级树策略，并不等于 profile 菜单 | 使用硬字段 `allowed_models` / `deny_models`，不必为此编造菜单条目；可与开关叠加，取有效交集 |

字段参考与更多示例见 [Agent 文件格式](./agents.md#agent-文件格式)。

## 定制机制地图

Kiki 的定制机制各管一件事。先想清楚要改什么，再选机制：

| 想改什么 | 用什么 |
| --- | --- |
| 跨会话复用的身份与私有记忆 | [角色、Bot 与房间](./personas.md) |
| Agent 的执行指令、可用工具、权限、模型 | **Profile 文件**（本页与 [Agent 与 subagent](./agents.md)） |
| 内置提示词里的一段具名文本（如语言要求、工具描述） | [Prompt 字段覆写](./prompt-fields.md) |
| 让 agent 在需要时自动调用的专业知识或工作流 | [Agent Skills](./skills.md) |
| 自己用 `/名字` 主动触发的提示片段 | [提示命令](./skills.md#自定义提示命令) |
| 把 profile、Skill、命令、hook 打包分发给团队 | [Plugins](./plugins.md) |
| 在工具调用、会话事件上拦截或通知 | [Hooks](./hooks.md) |
| 终端界面配色 | [自定义主题](./themes.md) |

## 下一步

- [Agent 与 subagent](./agents.md) — profile 字段参考、派发方式、SYSTEM.md 与运行时行为
- [Agent Skills](./skills.md) — 给 agent 注入可复用的工作流
