---
layout: home
title: Kiki（kiki-agent）— 多模型 AI 智能体工作台
titleTemplate: false
hero:
  name: Kiki
  text: 一件事，几家模型分工做。
  tagline: 开源的本地智能体工作台。主会话把活拆开：规划交给强模型，日常的活交给便宜的模型，审查换一家厂商。每个帮手用哪个模型由你定——你的智能体，你说了算。
  actions:
    - theme: brand
      text: 快速上手
      link: ./getting-started/installation
    - theme: alt
      text: 看看它能做什么
      link: ./features/index
    - theme: alt
      text: 发布说明
      link: ./release-notes/changelog
features:
  - title: "一个主会话，调配不同模型的帮手"
    details: "活能拆开时，主智能体把子任务派给上下文隔离的子智能体——探查用快模型、写作或实现换另一个、审查再换一家厂商。每个子智能体的记录都能点开看，后台任务跑完会自动回来报到。"
    link: ./features/workbench
  - title: "每个模型都有自己的专武"
    details: "别家工具各为自家模型调；Kiki 用配方（Recipe）给接进来的每个模型单独调：一套提示词加模型设置，装一次，绑在模型上。作者发布了五套，分别给 GPT-6.1 Sol、GPT-6 Astra、DeepSeek V4.1、Gemini 4 Argon 和 Gemini 3.8 Flash；可以照着改，也可以自己写。"
    link: ./customization/recipes
  - title: "跑在你的机器上，哪个窗口打开都是同一场工作"
    details: "工作文件留在你选定的文件夹里，会话、历史和配置留在本机。在桌面应用、终端 `kiki` 或浏览器 `kiki web` 里开的会话，换个窗口打开还是它。"
    link: ./getting-started/first-launch
  - title: "每个角色就是一份可读可改的 Markdown"
    details: "每个 Agent Profile 是一份由你掌控的纯文本 Markdown：Frontmatter 定模型、思考档位、可用工具与可派发的子智能体，正文就是系统提示词。可以直接用内置的 `explore`、`implementer`、`reviewer` 等角色，也能按需新建。"
    link: ./features/agent-workflows
  - title: "跨轮次与跨会话推进长线工作"
    details: "用 `/goal` 让目标跨轮次留在视线里；趁它正忙先把消息排进队列，逐条选在本轮结束后、子智能体完成后或任务完成后送达；配合持有会话期间触发的定时提示词，以及可逐条撤销的分层记忆。"
    link: ./features/long-work
  - title: "有长期记忆的角色与多方讨论房间"
    details: "给常驻搭档一个名字、长期规则、独立记忆和固定的日常对话入口；或者把两到六个角色与现有会话拉进同一个房间，在主持人和发言预算下围绕一个议题碰撞。"
    link: ./features/people
  - title: "连接浏览器，或按需装上文档、表格、数据与媒体插件"
    details: "当工作走出纯文本，可连接浏览器（Ego Lite、浏览器扩展或独立受管浏览器），或按需从目录安装对应插件：把本地 PDF 与 Office 提取成 Markdown（`Kiki Extract`）、读写 Word/Excel/PPT（`Kiki Office Suite`）、核对本地 CSV（`Kiki Work`）、查金融与文献数据（`Kimi Datasource`）或生成多模态素材（`Kiki Media`）。"
    link: ./features/extend
  - title: "提示词、工具描述与审批边界都能改"
    details: "内置提示词的任意具名字段都能按全局、模型或智能体替换，细到单独给某个模型改写一条工具描述；用 `kiki prompt-fields` 核对实际生效文本，并在手动、自动、替我审批与 YOLO 之间设定边界。"
    link: ./features/freedom
  - title: "看得见花了多少，也看得见谁被哪条规则拦住"
    details: "用量页直接标出挡住等待请求的那条并发规则；供应商未返回用量的调用标为未知而非伪装成 0；外部同步只发不含正文的统计数字，且只有你明确同意当前目的端和范围后才会启用，预览可选。"
    link: ./features/daily
  - title: "跨空间、连手机，也接得进你现有的工具"
    details: "工作文件留在你的目录里，会话、历史与凭据留在本机 Kiki home。支持分空间隔离工作与个人账号、绑微信或 QQ 在手机上回复和审批、把既有对话历史导成会话或只读归档，或通过 `kiki acp` 与 `kiki seat` 接入常用 IDE。"
    link: ./features/spaces
---
