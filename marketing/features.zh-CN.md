# Kiki 功能一览

每项功能配一句话说明、一张截图和详细文档链接。[返回 README](../README.zh-CN.md) · [截图巡览](gallery.zh-CN.md)

*截图由真实 Kiki 界面在示例项目上渲染，展示的是界面，不代表模型性能实测。标注「即将推出」的内容还在开发中，尚未发布。*

## 智能体与模型

### 子智能体，各用各的模型

主智能体会自己派子智能体干活，每个角色可以绑不同供应商的模型：强模型负责规划，便宜的模型跑杂活。每个子智能体有独立上下文，对话记录随时点开看。

![派发树：每个角色绑定了不同的模型。](shots/r05-multi-model-fleet.zh.light.png)

[具名子 Agent →](https://x-t-e-r.github.io/kiki/zh/customization/agents#具名子-agent)

### 智能体就是你自己的文件

一个智能体就是一份 Markdown：frontmatter 写工具、模型和能派发谁，正文就是系统提示词。现成的 Claude Code、OpenCode agent 文件直接能用。在应用里用模板新建智能体即将推出。

![在设置里打开的子智能体 Markdown 文件。](shots/r01-reviewer-profile.zh.light.png)

[Agent 文件格式 →](https://x-t-e-r.github.io/kiki/zh/customization/agents#agent-文件格式)

### 提示词字段覆写

内置提示词的任意字段都能换掉，细到单个工具的描述，可以全局设，也可以按模型或按智能体设；`kiki prompt-fields` 能看到模型最终收到的内容。

![提示词字段覆写与渲染预览。](shots/d02-prompt-fields.zh.light.png)

[提示词字段与覆写 →](https://x-t-e-r.github.io/kiki/zh/customization/prompt-fields)

### 供应商与模型

Kimi、Anthropic、DeepSeek / Qwen 等 OpenAI 兼容服务、OpenAI Responses API、Gemini、Vertex AI 都能接。每个模型起个别名，就能绑给具体角色。

*截图待补：`a05-providers-models`。*

[平台与模型 →](https://x-t-e-r.github.io/kiki/zh/configuration/providers)

## 长时间的活

### 后台任务

耗时的命令和子智能体可以丢到后台跑，跑完结果会自动回到智能体手里，你和它都不用盯着。

![任务页：一个运行中的任务已展开。](shots/d03-tasks-page.zh.light.png)

[后台任务 →](https://x-t-e-r.github.io/kiki/zh/reference/tools#后台任务)

### 目标与消息队列

用 `/goal` 定一个目标，智能体会跨多轮一直推进；`/goal next` 可以提前排好下一个目标。它忙的时候你发的消息先进队列，不会打断它；每条消息可以单独选什么时候发：空闲后、子智能体完成后，或任务完成后。

![进行中的目标和排队的消息。](shots/r02-goal-queue.zh.light.png)

[目标模式 →](https://x-t-e-r.github.io/kiki/zh/guides/goals#安排后续目标)

### 定时任务

智能体可以在当前会话里定时投一条 prompt，一次性或按 cron 周期都行，适合定期检查、日报和提醒。

![周期和一次性的定时任务。](shots/d05-cron-panel.zh.light.png)

[定时任务 →](https://x-t-e-r.github.io/kiki/zh/reference/tools#定时任务)

### 任务看板

每个工作区一块看板，需求是卡片，卡片关联到正在处理它的会话；主智能体也能读写看板。

![工作区任务看板。](shots/r04-task-board.zh.light.png)

[任务看板介绍 →](task-board.zh-CN.md) · [文档 →](https://x-t-e-r.github.io/kiki/zh/guides/sessions#需求看板)

## 找东西

### 联网搜索与抓取

搜索和抓取走可以查看状态的命名通道；GitHub 和 Context7 通道不用密钥，同一家供应商的多个密钥自动轮换、出错冷却。

![搜索通道及其就绪状态和原因。](shots/d06-search-lanes.zh.light.png)

[nb-search 介绍 →](nb-search.zh-CN.md) · [文档 →](https://x-t-e-r.github.io/kiki/zh/reference/tools)

### 会话搜索

按 Cmd/Ctrl+K，按标题、工作区和上一条 prompt 搜会话。搜对话正文即将推出。

*截图待补：`a03-session-search`。*

[变更记录 →](https://x-t-e-r.github.io/kiki/zh/release-notes/changelog)

### 视频输入

把录屏或视频片段粘进对话，让模型帮你看，前提是当前模型支持视频输入。

![会话中内联播放的视频附件。](shots/d08-video-attachment.zh.light.png)

[粘贴图片与视频 →](https://x-t-e-r.github.io/kiki/zh/guides/interaction#粘贴图片与视频)

## 控制与扩展

### 权限模式

问不问你，由你定：手动模式有副作用就问；自动模式放行日常操作，碰到敏感目标还是会问；YOLO 全部放行；显式的 deny 规则永远优先。「替我审批」即将推出：由你指定的审查模型判断高风险操作，拿不准的交回给你。

*截图待补：`a01-approve-for-me`。*

[交互与审批 →](https://x-t-e-r.github.io/kiki/zh/guides/interaction)

### 插件、MCP 与 Skills

接 MCP 服务器调用外部工具；把常用流程写成 Skill，也能当斜杠命令用；插件可以把 Skill、智能体和 MCP 服务器打包成一个安装。

*截图待补：`a06-plugins-mcp-skills`。*

[插件 →](https://x-t-e-r.github.io/kiki/zh/customization/plugins) · [MCP →](https://x-t-e-r.github.io/kiki/zh/server/mcp) · [Skills →](https://x-t-e-r.github.io/kiki/zh/customization/skills)

### Hooks

在生命周期事件上跑你自己的脚本：拦下危险的 shell 命令、提交消息时补充上下文、任务跑完弹个通知。

*截图待补：`a07-hooks`。*

[Hooks →](https://x-t-e-r.github.io/kiki/zh/customization/hooks)

## 在哪儿用

### 桌面、终端、浏览器

桌面应用、终端界面（`kiki`）和浏览器界面（`kiki web`）共用一个本地守护进程，读写同一份会话数据。

![Kiki 桌面工作台。](shots/h01-fleet-workbench.zh.light.png)

[Kiki 桌面版 →](https://x-t-e-r.github.io/kiki/zh/getting-started/desktop-app) · [首次启动 →](https://x-t-e-r.github.io/kiki/zh/getting-started/first-launch) · [本地服务与浏览器界面 →](https://x-t-e-r.github.io/kiki/zh/server/local-server)

### 在编辑器里用（ACP）

运行 `kiki acp`，就能在 Zed、JetBrains IDE 等 Agent Client Protocol 客户端里把 Kiki 当智能体用。

*截图待补：`a08-acp-editor`。*

[在 IDE 中使用 →](https://x-t-e-r.github.io/kiki/zh/server/ide)
