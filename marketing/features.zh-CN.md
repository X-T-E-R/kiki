# Kiki 功能一览

每项能力对你有什么用，以及详细说明在哪。在线的**功能介绍**分类是完整导览，这一页是仓库内的索引。[返回 README](../README.zh-CN.md) · [截图巡览](gallery.zh-CN.md) · [在线功能一览 →](https://x-t-e-r.github.io/kiki/zh/features/)

## 从这里开始

- **安装与首次运行。** npm 需要 Node.js 24.15.0+，也可以从 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 下载桌面版。新会话默认是「自动」；`/permission` 在「每步询问」（`manual`）、「自动」（`auto`）、「替我审批」（`review`）和「完全放行」（`yolo`）之间切换。[安装 →](https://x-t-e-r.github.io/kiki/zh/getting-started/installation)
- **首次运行先讲能做什么。** 桌面版欢迎页先介绍 Kiki 能帮你做什么，再给几条导览路线；侧栏的 **发现 Kiki** 一直留着它们，起步建议没连模型也能填进草稿。[首次启动 →](https://x-t-e-r.github.io/kiki/zh/getting-started/first-launch)
- **三个界面，一个守护进程。** 桌面应用、终端里的 `kiki` 和 `kiki web` 读写同一批会话。[桌面版 →](https://x-t-e-r.github.io/kiki/zh/getting-started/desktop-app) · [本地服务 →](https://x-t-e-r.github.io/kiki/zh/server/local-server)
- **登录。** Kimi Code OAuth 或 Kimi 开放平台 API 密钥开箱即用；Anthropic、OpenAI 兼容服务、OpenAI Responses API、Gemini、Vertex AI 都能接。[平台与模型 →](https://x-t-e-r.github.io/kiki/zh/configuration/providers)

## 每个智能体各用各的模型

- **子智能体，各用各的模型。** 主智能体自己派子智能体，每个智能体可以绑不同供应商的模型，强模型负责规划，便宜的模型跑日常。每个子智能体有独立上下文，对话记录随时点开看。[具名子 Agent →](https://x-t-e-r.github.io/kiki/zh/customization/agents#具名子-agent)
- **智能体就是你自己的文件。** 每个智能体一份 Markdown：frontmatter 写工具、模型、思考强度和能派发谁，正文就是系统提示词。可以从现有 profile 复制、从内置模板起，或者从空白开始。[Agent 文件格式 →](https://x-t-e-r.github.io/kiki/zh/customization/agents#agent-文件格式)
- **把别的智能体当引擎用。** 一个 profile 可以通过 ACP 或 Codex app-server 跑在 Claude Code、Codex、Cursor、Gemini CLI、Kimi CLI、OpenCode 或 Grok Build 上。[派遣能力 →](https://x-t-e-r.github.io/kiki/zh/guides/settings#派遣能力)
- **后台任务。** 耗时的命令和子智能体丢到后台跑，跑完结果自动回到智能体手里。[后台任务 →](https://x-t-e-r.github.io/kiki/zh/reference/tools#后台任务)

## 让活跨过会话

- **目标。** `/goal` 给智能体一个跨多轮持续推进的目标，可以编辑、暂停和取消。[目标模式 →](https://x-t-e-r.github.io/kiki/zh/guides/goals)
- **消息队列。** 智能体忙着时你发的消息先进队而不是打断，每条可以选空闲后、子智能体完成后，或任务完成后发出。[队列 →](https://x-t-e-r.github.io/kiki/zh/guides/interface#输入框)
- **定时提示词。** 智能体可以安排一次性或按 cron 表达式重复的提示词。只要还有 Kiki 进程持有那个已打开的会话，计划就会触发。[定时任务 →](https://x-t-e-r.github.io/kiki/zh/reference/tools#定时任务)
- **任务看板。** 每个工作区一块看板，需求是卡片，关联到正在处理它的会话；主智能体也能读写。[任务看板 →](https://x-t-e-r.github.io/kiki/zh/guides/sessions#任务看板) · [专题介绍 →](task-board.zh-CN.md)
- **上下文撑得住。** 压缩点由你定；到了压缩点，智能体压成摘要、只从工作笔记重启，或每次自己判断。[上下文压缩 →](https://x-t-e-r.github.io/kiki/zh/guides/sessions#上下文压缩)
- **记忆。** 事实按全局、工作区或角色跨会话留下，改动历史可以逐条撤销。[记忆 →](https://x-t-e-r.github.io/kiki/zh/guides/memory)

## 在手头的窗口里干活

- **时间线不会越拉越乱。** 做完的一段工具调用折成一行，比如「Worked · 8 steps」，每折都能按原顺序展开。[界面导览 →](https://x-t-e-r.github.io/kiki/zh/guides/interface)
- **批注。** 在消息上留一条批注，随下一条消息一起发出去，不必单独打断一轮。[输入框 →](https://x-t-e-r.github.io/kiki/zh/guides/interface#输入框)
- **用量。** 某个日期区间的 token 与费用、正在跑和排队的请求及并发规则，以及不含内容的外部同步。[Usage →](https://x-t-e-r.github.io/kiki/zh/guides/settings#usage)
- **搜索。** `HistorySearch` 和 `HistoryRead` 让智能体搜索之前的消息和工具输出，压缩前的内容也在范围内；侧栏里会话标题始终可搜。[内置工具 →](https://x-t-e-r.github.io/kiki/zh/reference/tools#历史工具)

## 能一起干活的角色

- **角色。** 长期身份——名字、头像、职责、它该怎样工作的长期约定，以及它自己的记忆——存成一份你能读能改的 Markdown。[角色、Bot 与房间 →](https://x-t-e-r.github.io/kiki/zh/customization/personas)
- **固定的日常对话。** 点角色的名字每次落进同一个对话；同一个角色可以同时有多段对话。
- **房间。** 两到六个角色按顺序讨论同一个话题，有主持人、有预算、有暂停和继续。
- **角色不等于智能体配置。** profile 是执行配置——工具、权限、模型、思考强度；角色是身份——它是谁、记得什么。

## 数据与机器都在你手上

- **空间。** 每个空间就是你要打开的某一个 Kiki，有自己的快捷方式、窗口行为和凭据范围——与主空间共享或本空间独立。[设置页 →](https://x-t-e-r.github.io/kiki/zh/guides/settings)
- **远端连接。** 从一个 Kiki home 指向另一个的有向链路，两边各自审批；`inbound revoke` 停掉某一个来源，不影响其他已批准的。[`kiki connections` →](https://x-t-e-r.github.io/kiki/zh/reference/command#kiki-connections)
- **Thread bridge。** 两个 home 之间传消息的单向通道，永远不授予 GUI 浏览权限。[`kiki bridges` →](https://x-t-e-r.github.io/kiki/zh/reference/command#kiki-bridges)
- **Web 访问。** 用一条一次性链接把这个 Kiki 开给另一台设备上的浏览器；关掉时撤销所有链接，但不会停掉正在跑的活。[Web 访问 →](https://x-t-e-r.github.io/kiki/zh/server/local-server#在浏览器里使用-kiki)
- **会话内 SSH。** 加入会话的主机属于这个会话，所以时间线保持干净。[输入框 →](https://x-t-e-r.github.io/kiki/zh/guides/interface#输入框)

## 每一层都归你

- **提示词字段覆写。** 内置提示词的任意具名部分都能换掉，细到单个工具描述，可以全局、按模型或按智能体设；`kiki prompt-fields` 能看到模型最终收到什么。[提示词字段与覆写 →](https://x-t-e-r.github.io/kiki/zh/customization/prompt-fields)
- **连接与 OAuth。** Kiki 触达模型的每一种方式都是一张列表里的一行，怎么认证也是这一行自身的事。用设备流登录订阅账号，或者复用本机已有的登录。[连接服务 →](https://x-t-e-r.github.io/kiki/zh/guides/settings#连接)
- **权限模式。** 「每步询问」（`manual`）有副作用就问；「自动」（`auto`）放行日常操作，碰到敏感目标还是会问；「替我审批」（`review`）把策略产生的审批请求交给你配置的审查者；「完全放行」（`yolo`）全部放行。显式 deny 永远优先。[权限模式 →](https://x-t-e-r.github.io/kiki/zh/guides/interaction#权限模式)
- **Hooks。** 在生命周期事件上跑你自己的脚本：拦下危险的 shell 命令、提交消息时补充上下文、任务跑完弹通知。[Hooks →](https://x-t-e-r.github.io/kiki/zh/customization/hooks)

## 带进历史，接上别的工具

- **会话历史导入。** 把 Claude Code、Codex、Pi、Grok Build、OpenCode 的对话导成能接着做的 Kiki 会话，或只读归档；预览会写明保留什么、不保留什么。[会话历史导入 →](https://x-t-e-r.github.io/kiki/zh/customization/plugins#会话历史导入)
- **通过 ACP 接入 IDE。** `kiki acp` 让 Kiki 跑在 Zed、JetBrains IDE、Paseo 等 Agent Client Protocol 客户端里。[在 IDE 中使用 →](https://x-t-e-r.github.io/kiki/zh/server/ide) · [ACP 参考 →](https://x-t-e-r.github.io/kiki/zh/server/acp)
- **外部工具调用 Kiki。** `kiki seat` 为 Cursor、Claude Code、Codex 这类入站 MCP 客户端固定席位：工作区、权限模式和模型在它们连上之前就定好了。[`kiki seat` →](https://x-t-e-r.github.io/kiki/zh/reference/command#kiki-seat)

## 外观与扩展

- **皮肤与外观。** 六套内置皮肤、图片或视频背景，以及把配色和素材打包在一起的外观包。[GUI 皮肤 →](https://x-t-e-r.github.io/kiki/zh/customization/skins)
- **插件。** 插件可以加入技能、智能体、MCP 服务器、hooks、命令和工具，在「能力」页浏览安装。[插件 →](https://x-t-e-r.github.io/kiki/zh/customization/plugins)
- **Skills。** 可复用的工作流，同时注册成可以用 `/名字` 触发的斜杠命令。[Agent Skills →](https://x-t-e-r.github.io/kiki/zh/customization/skills)
- **MCP 服务器。** 通过 stdio、HTTP 或 SSE 连接外部工具。[MCP →](https://x-t-e-r.github.io/kiki/zh/server/mcp)
- **联网搜索与抓取。** 搜索和抓取走可查看的具名通道；GitHub 和 Context7 不用密钥，同一供应商的多个密钥自动轮换、出错冷却。[搜索与抓取 →](https://x-t-e-r.github.io/kiki/zh/guides/settings#搜索与抓取) · [专题介绍 →](nb-search.zh-CN.md)
