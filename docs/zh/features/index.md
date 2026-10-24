---
title: Kiki 能做什么
---

# Kiki 能做什么

Kiki 是一个跑在你机器上的开源 AI 智能体工作台。你把一个文件夹和想要的结果交给它——摸清陌生代码库、核对一摞 PDF 与表格、写出一份报告，或是完成跨文件的工程改动——主智能体负责拆解计划、把独立的活派给子智能体，并让目标跨轮次留在视线里。

工作文件留在你选定的文件夹里；会话、历史和配置保存在你本机的 Kiki home 下，模型请求只发往你自己连接的供应商或本地服务。桌面应用、终端界面（`kiki`）和浏览器界面（`kiki web`）连接同一个本地守护进程，在一个窗口开的活，换一个窗口接着做。

![Kiki 工作台：主会话派出的子智能体、进行中的目标和一条排队消息同屏可见。](/shots/index/wl-20261005-hero-workbench.zh.png)

第一次用 Kiki？先看 [安装](/zh/getting-started/installation) 和 [首次启动](/zh/getting-started/first-launch)，再回到这里。已经在用？按你想做的事直接往下看——每一节对应左侧栏的一组能力，点进专页即可查看完整工作流与设置入口。

## 多模型分工与并行任务

当一件事超过单轮对话或单个模型的承载范围时，Kiki 把工作拆给不同的角色和模型同时推进，并把长线目标与项目记忆留存下来。

- **[子智能体与多模型分工](/zh/features/workbench)**：主智能体派发上下文隔离的子智能体，支持把规划、探索和审查分别绑到不同模型或不同厂商；你可以随时点开任意子智能体的独立记录或直接给它发消息，后台任务跑完会自动带回结果通知主会话。
- **[Agent Profiles](/zh/features/agent-workflows)**：每个角色是一份可读可改的纯文本 Markdown（模型、思考档位、工具白名单、系统提示词与可派发的子智能体）。支持开箱即用的内置角色与 `implementer`、`reviewer` 模板，保存后即热刷新。
- **[目标、队列、定时与记忆](/zh/features/long-work)**：用 `/goal` 挂起跨轮次目标；智能体正忙时新消息进入队列并可逐条选择送达时机；配合本地时区定时任务（Cron）、可选的 `kiki-task-board` 需求看板、上下文续接（`Summarize`、`Fresh`、`Auto`）以及全局、工作区、角色三层可逐条撤销的长期记忆。
- **[常驻角色与讨论房间](/zh/features/people)**：给常驻搭档（Persona）独立身份、专属记忆与固定日常对话入口；或把两到六个角色与现有会话线程拉进同一个房间，在主持人和发言预算下围绕同一话题展开讨论。

![同一个会话里用了好几种模型：派发树中每个角色绑定不同的模型。](/shots/workbench/workbench-per-role-models.zh.png)

## 浏览器与电脑控制

当工作走出本地文件，需要点开网页、操作已登录后台，或是驱动没有 API 的桌面软件时，进入 **[浏览器与电脑控制](/zh/features/browser-and-computer)** 按需配置并启用对应能力。Kiki 自身的浏览器驱动、由它启动的独立浏览器和电脑控制都运行在 Kiki 服务机上；你也可以直接连上本机或远端已有的浏览器。

- **[浏览器控制](/zh/features/browser-and-computer#浏览器控制)**：完成组件配置并勾选允许使用的浏览器后，智能体即可打开页面、读取快照、点击、填表与截图。支持通过 **Kimi / Codex 浏览器扩展**直接操控你日常已登录的浏览器、由 Kiki 启动隔离 Cookie 的**独立浏览器**、接入你自行安装的 **Ego Lite**，或通过 **CDP** 附着到本机与远端已有浏览器。
- **[电脑控制](/zh/features/browser-and-computer#电脑控制)**：提供两条需你手动安装并授权后才启用的桌面操作路径——在 [设置 → 电脑控制](/zh/guides/settings#电脑控制) 中安装开源执行器（默认优先用 CLI、API、脚本和浏览器工具，仅在你明确要求或改为**更倾向**时动用桌面），或安装 **[Kimi Computer Use 插件](/zh/customization/plugins#kimi-computer-use)**（macOS 支持后台静默点击输入、不抢鼠标；Windows 在交互式桌面中运行并短暂使用当前窗口与键鼠）。

## 文档、数据与媒体

通过 **[插件、Skill、MCP 与搜索](/zh/features/extend)**，把文档解析、Office 编辑、专业数据库、多媒体生成和可查看的网页检索接入工作台：

- **本地文档提取与 Office 办公**：从 **Official** 插件目录按需安装 `Kiki Extract`（本地 PDF、Office、HTML 转 Markdown，不改原件）、`Kiki Office Suite`（本机创建与编辑 Word、Excel、PowerPoint）、`Kiki Work`（本机核对 CSV/TSV 与比对两张表，不上传）与 `Kiki Writing`（手稿面板与续写命令）。
- **专业数据、外部服务与媒体生成**：安装 `Kimi Datasource` 用自然语言查股票行情、宏观指标、企业工商、学术文献与中国法律法规；用 `Kiki Notion` 检索并写回指定 Notion 页面；通过 `Kiki Media` 配置图像、视频、语音生成服务或本地脚本。
- **网页搜索、抓取通道、Skills 与 MCP**：用 `WebSearch` 搜索网页，用 `FetchURL` 读取页面内容；默认通道无需密钥，也可接入代码库与文档等专用通道，并在**设置 → 能力 → 搜索与抓取**中查看凭据来源、多密钥轮换与提取器回退顺序。支持用 Markdown 编写 [Agent Skills](/zh/customization/skills)，或通过 `stdio`、`HTTP`、`SSE` 接入 [MCP 服务器](/zh/server/mcp)。

![抓取通道页签：一个网址按顺序经过哪些提取器，以及每一级回退到哪里。](/shots/extend/ce-20261005-extend-fetch-chain.zh.png)

## 用量、模型与权限

智能体在做什么、花了多少钱、哪个请求为什么排队、模型实际收到了什么指令，在工作台里都有直接对应的面板与开关。

- **[日常界面与用量监控](/zh/features/daily)**：已完成步骤自动折叠、消息锚定批注、「需要你」审批托盘与焦点跟随右栏让长对话保持清爽；侧栏 **Usage（用量）** 页展示带完整性标记的历史花费（未上报调用标为未知而非 0）、直接点名限流规则 ID 的实时排队列表、账号剩余额度，以及须经你预览载荷并同意后才启用的无正文外部同步。
- **[模型连接、提示词与权限](/zh/features/freedom)**：一张列表管理 API 密钥、OAuth 订阅与本地服务，支持先**检测本机**再直接复用本机已有的 ChatGPT（Codex）或 Grok Build 登录；支持细到单条工具描述的提示词字段覆写（`kiki prompt-fields`）、四种权限模式（`manual`、`auto`、`review`、`yolo`）、Plan 模式与生命周期 Hooks。
- **[皮肤、字体与背景](/zh/features/look)**：内置六套浅色与深色皮肤（及外观包、TUI 主题），支持实时微调强调色、字体、圆角与密度，或放入自动保障文字对比度的本地图片与视频背景。

![用量页的「实时」页签：按模型统计的进行中与排队计数，一条正在等待的请求写明挡住它的 kimi-cap 规则，下方是并发限制规则列表，一条启用、一条已停用。](/shots/daily/ux-usage-live.zh.png)

## 手机、远程与工具集成

数据默认留在你的本机 Kiki home 下，同时支持按你的授权跨工作空间、跨机器、跨手机与跨工具协同。

- **[多空间、远程连接与 SSH](/zh/features/spaces)**：用**空间**隔离或共享工作与个人凭据（支持含办公组件的 Work 模式预设）；通过需双方各自批准的单向**远端连接**或仅传消息不授浏览权的 **thread bridge** 跨机协作；用 `kiki web` 生成一次性浏览器访问链接；或在输入框上方把 **SSH** 主机加入当前会话，直接读写远端文件、跑远端命令。
- **[手机会话](/zh/features/phone)**：在**设置 → 通知与消息**中用微信扫码或配置 QQ 机器人，把聊天绑定到角色或指定会话；人不在电脑前也能用手机发消息（排队或插入当前回合）、看回复，并用数字回答待处理的提问与审批。
- **[历史导入、IDE 与外部引擎](/zh/features/ecosystem)**：无需插件即可把 Claude Code、Codex、Pi、Grok Build、OpenCode 的旧对话预览并导入为可继续的会话或只读归档；通过 `kiki acp` 在 Zed、JetBrains 等 IDE 中驱动 Kiki，用 `kiki seat` 固定入站 MCP 席位，或把这些外部工具设为子智能体的执行引擎。

![导入历史：六个可读的来源，以及一段对话的预览，写明哪些内容不会带过来。](/shots/ecosystem/ecosystem-history-import.zh.png)

## 功能目录速查

| 页面 | 什么时候看 | 核心内容 |
| --- | --- | --- |
| [子智能体与多模型分工](/zh/features/workbench) | 任务超过单轮对话或单个模型 | 桌面 / 终端 / Web 共用守护进程、主会话派发子智能体、按角色绑定不同模型、独立子记录、后台任务 |
| [Agent Profiles](/zh/features/agent-workflows) | 想保存可复用的专业角色 | 单文件 Markdown 定义角色、模型与思考档位继承、内置角色与 `implementer` / `reviewer` 模板、热刷新 |
| [目标、队列、定时与记忆](/zh/features/long-work) | 活要跑几小时、跨天或按计划重复 | `/goal` 跨轮次目标、带送达时机的忙碌队列、定时任务、可选任务看板、上下文续接与三层可撤销记忆 |
| [常驻角色与讨论房间](/zh/features/people) | 想要固定搭档或多视角同屏讨论 | 角色卡（Persona）、固定日常对话入口、角色独立记忆、2–6 个角色或线程在主持人与预算下讨论的房间 |
| [浏览器与电脑控制](/zh/features/browser-and-computer) | 需要操作网页后台或桌面软件 | 日常已登录浏览器扩展、独立受管浏览器、Ego Lite 与 CDP 附着；内置电脑控制执行器与 Kimi Computer Use 插件 |
| [插件、Skill、MCP 与搜索](/zh/features/extend) | 处理文档、表格、数据、网页与媒体 | PDF/Office 提取与编辑、表格比对、金融文献数据、媒体生成、`WebSearch` 搜索与 `FetchURL` 抓取通道、`/skill`、MCP |
| [日常界面与用量监控](/zh/features/daily) | 盯进度、盯花费或排查排队请求 | 步骤折叠时间线、消息批注、「需要你」审批托盘、焦点右栏、Usage 历史花费 / 实时限流规则 / 额度 / 外部同步 |
| [模型连接、提示词与权限](/zh/features/freedom) | 管理账号连接、改写提示词或管住审批 | 连接与 OAuth 列表、复用本机 ChatGPT / Grok Build 登录、`kiki prompt-fields` 覆写、四种权限模式与 Hooks |
| [皮肤、字体与背景](/zh/features/look) | 调整窗口配色、字体或背景 | 六套内置浅深色皮肤、强调色与字体密度微调、自动保障对比度的本地图片与视频背景、外观包与 TUI 主题 |
| [多空间、远程连接与 SSH](/zh/features/spaces) | 分开工作与个人账号，或跨机器干活 | 多空间凭据隔离与共享、Work 模式预设、双向批准远端连接、单向 thread bridge、一次性 Web 链接、会话内 SSH |
| [手机会话](/zh/features/phone) | 人不在电脑前，需要回复或审批 | 微信扫码与 QQ 机器人绑定、按联系人路由到角色或会话、忙碌插入与排队、手机端数字回复提问与审批 |
| [历史导入、IDE 与外部引擎](/zh/features/ecosystem) | 迁移旧对话，或与 IDE / 外部工具协同 | 预览式导入 Claude Code / Codex / Pi / Grok Build / OpenCode 历史、`kiki acp` IDE 集成、`kiki seat` 席位、外部执行引擎 |
