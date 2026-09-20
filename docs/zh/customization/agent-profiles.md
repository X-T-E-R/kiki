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

## 定制机制地图

Kiki 有六种定制机制，各管一件事。先想清楚要改什么，再选机制：

| 想改什么 | 用什么 |
| --- | --- |
| agent 的身份、系统提示词、可用工具、模型 | **Profile 文件**（本页与 [Agent 与 subagent](./agents.md)） |
| 内置提示词里的一段具名文本（如语言要求、工具描述） | [Prompt 字段覆写](./prompt-fields.md) |
| 让 agent 在需要时自动调用的专业知识或工作流 | [Agent Skills](./skills.md) |
| 自己用 `/名字` 主动触发的提示片段 | [提示命令](./skills.md#自定义提示命令) |
| 把 profile、Skill、命令、hook 打包分发给团队 | [Plugins](./plugins.md) |
| 在工具调用、会话事件上拦截或通知 | [Hooks](./hooks.md) |
| 终端界面配色 | [自定义主题](./themes.md) |

## 下一步

- [Agent 与 subagent](./agents.md) — profile 字段参考、派发方式、SYSTEM.md 与运行时行为
- [Agent Skills](./skills.md) — 给 agent 注入可复用的工作流
