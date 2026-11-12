# LinuxDo 草稿

**分类：** 开发调优（或 资源荟萃，以版规为准）
**标签：** 开源、AI、DeepSeek、GLM

**标题：** 一个任务里同时用几家模型是什么体验：按角色绑模型、给每个模型装专武配方（开源 MIT）

**正文：**

一个任务里同时用几家模型是什么体验。一件事，几家模型分工做。你的智能体，你说了算。

Kiki 是一个开源（MIT）的本地智能体工作台，作为服务跑在你自己的机器上，桌面端、终端（`kiki`）、浏览器（`kiki web`）和手机看到的是同一场工作。这帖不讲大词，讲怎么在同一个会话里把不同厂商的模型编排到一起，以及怎么给原生模型调配方。

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

分工大致是：

- 主会话（规划、拆活、验收）：强模型
- 实现、范围明确的改动：DeepSeek
- 只读探查：GLM
- 审查：换一家厂商，避免自己审自己

`model_alias` 对应 `config.toml` 里 `[models]` 的别名；DeepSeek 走 `openai` 兼容类型。子智能体**没有绑模型、也没有配默认模型时会直接报错**（`model.not_configured`），不会偷偷继承主会话的模型。派发时也可以临时换模型，偏离了角色推荐会记一条提示，不拦你。

## 2. 每个模型都有自己的专武

Claude Code 是照着 Claude 调的，Codex 是照着 GPT 调的；Kiki 用配方（Recipe）给接进来的每个原生模型单独调——Recipe 把提示词、模型设置和可选脚本 Hook 打包在一起，安装一次，绑在一个模型上，每个绑定保留自己的选项开关。

作者已经在公开仓库 https://github.com/X-T-E-R/kiki-recipes （MIT，同时也是一个可订阅的配方市场）发布了五套配方：

- **GPT-6.1 Sol**：主模型，先想透意图与完成标准，再用判断力和品味收尾
- **GPT-6 Astra**：在 Astra 上沿用同一套工作方式，主从分工不变
- **DeepSeek V4.1**：针对思考偏浅、字面执行的模型，动手前先推演机理与反例
- **Gemini 4 Argon**：Argon 主模型，在美学层之外带契约内子智能体质量层
- **Gemini 3.8 Flash**：高频小模型，做写作、前端和有界杂活时先锚定样板

在我看来，每个模型就像一个性格不同的孩子，我也算哄好了好几个脾气各异的模型——比如给 DeepSeek V4.1 装上配方，让它动手前先把机理和反例推出来。Recipe 只对 Kiki 原生运行的模型生效；如果某一步交给 Claude Code 或 Codex 作为外部执行器来跑，它走的是外部执行器自己的规则，不会套用 Recipe。

## 3. 还要更细？按模型覆写单条工具描述

除了整套配方，内置提示词的每个具名字段也能单独覆写，优先级从低到高：全局 → 按模型 → 按模型 Recipe → 按 Profile Recipe → 按智能体 → 按智能体里的某个模型。

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
kiki prompt-fields list
kiki prompt-fields explain tool.web-search.description --model deepseek
```

`explain` 会列出生效值、被谁覆盖、完整来源链。字段 id 写错、文件不存在都会校验失败，不会静默忽略。

## 4. 并行执行与更多能力

主智能体调用 `AgentRun` 派子智能体，可以放到后台；后台跑完会自动通知它，不用它轮询。它忙的时候我发的消息进队列，每条可以选「空闲后 / 子代理完成后 / 任务完成后」再发。

桌面、终端（`kiki`）、浏览器（`kiki web`）共用一个本地守护进程；工作文件留在原文件夹，会话、历史和配置存在本机 Kiki home。需要时再按需装插件和扩展能力：可选插件 `kiki-task-board`（需求看板）、`Kiki Extract`（本地 PDF/Office 转 Markdown，需本机备好 Python + MarkItDown）、`Kiki Work`（本地 CSV 核对）、`Kiki Office Suite`（Word/Excel/PPT）、`Kiki Writing`；另外支持跨空间隔离、会话内 SSH、微信/QQ 手机审批、历史导入（Claude Code / Codex / OpenCode 等），以及用 `kiki acp` 接 Zed / JetBrains。

安装：`npm i -g kiki-agent`（Node 24.22.1+ 或 26.12.1+），或 GitHub Releases 下桌面版。

## 实话

`0.x`（目前版本 `0.5.1`），毛刺不少；macOS 包未签名未公证；Windows 需要 Git for Windows。我没做过跑分，也不打算说哪个模型组合更好，只是分享一种配法。截图是真实界面渲染的示例场景（`docs/public/shots/`）。

仓库：https://github.com/X-T-E-R/kiki

欢迎佬们分享自己的模型分工，尤其是给国产模型写配方和改工具描述的经验。
