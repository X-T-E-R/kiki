# LinuxDo 草稿

**分类：** 开发调优（或 资源荟萃，以版规为准）
**标签：** 开源、AI、DeepSeek、GLM

**标题：** 用 Kiki 把 DeepSeek / GLM 和强模型编在一起干活：按角色路由模型、按模型改工具描述（开源，附配置）

**正文：**

先说结论：Kiki 是我在做的一个开源（MIT）本地智能体工作台。这帖不讲大词，讲我自己怎么给不同的活分配模型，以及怎么调教便宜模型。

## 1. 按角色绑模型

每个智能体就是一份 Markdown，frontmatter 里写 `model_alias`：

```markdown
---
name: implementer
description: 按明确的范围实现改动并跑检查
model_alias: deepseek
tools: [Read, Grep, Glob, Edit, Write, Bash]
---
你负责实现……
```

我的分工大致是：

- 主会话（规划、拆活、验收）：强模型
- 实现、机械活：DeepSeek
- 只读探查：GLM
- 审查：换一家厂商，避免自己审自己

`model_alias` 对应 `config.toml` 里 `[models]` 的别名；DeepSeek 走 `openai` 兼容类型，`reasoning_content` 会自动处理。子智能体**没有绑模型就直接报错**（`model.not_configured`），不会偷偷继承主会话的模型，账单不会莫名变贵。派发时也可以临时换模型，偏离了角色推荐会记一条提示，不拦你。

## 2. 便宜模型用错工具？改它那一份工具描述

内置提示词的每个字段都能覆写，并且能只对某个模型生效。优先级从低到高：全局 → 按模型 → 按智能体 → 按智能体里的某个模型。

```toml
# ~/.kiki/config.toml
[models.deepseek.prompt_overrides]
files = ["prompt/deepseek.toml"]
```

```toml
# ~/.kiki/prompt/deepseek.toml
schema_version = 1

[fields]
"tool.web-search.description" = "……写成更短、更直白的版本……"
```

改完用这个确认模型到底收到什么：

```sh
kiki prompt-fields list                                   # 所有字段
kiki prompt-fields explain tool.web-search.description --model deepseek
```

`explain` 会列出生效值、被谁覆盖、完整来源链。字段 id 写错、文件不存在都会校验失败，不会静默忽略。

## 3. 让它们并行跑，而不是我来回切窗口

主智能体自己调用 `AgentRun` 派子智能体，可以放到后台；后台跑完会自动通知它，不用它轮询。它忙的时候我发的消息进队列，每条可以选「空闲后 / 子代理完成后 / 任务完成后」再发。工作区还有一块需求看板，智能体自己读写，换会话也不丢。

## 4. 其他

- 桌面、终端（`kiki`）、浏览器（`kiki web`）共用一个本地守护进程；Zed / JetBrains 可以通过 ACP 接。
- Claude Code、OpenCode 的 agent 文件直接能加载。
- 安装：`npm i -g kiki-agent`（Node 24.15+），或 GitHub Releases 下桌面版。

## 实话

0.x，毛刺不少；macOS 包未签名；Windows 需要 Git for Windows。我没做过跑分，也不打算说哪个模型组合「更好」，只是分享我的配法。截图是真实界面渲染的示例场景。

仓库：https://github.com/X-T-E-R/kiki

欢迎佬们分享自己的模型分工，尤其是国产模型的工具描述怎么写更稳。
