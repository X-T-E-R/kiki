---
layout: home
hero:
  name: Kiki
  text: 把一个文件夹和一件事交给它。
  tagline: 跑在你机器上的开源 AI 智能体工作台。摸清代码库、核对 PDF 与表格、写长文或改工程都能交出去——主会话按角色调度你选定的模型，桌面、终端与浏览器共用同一个本地会话存储。
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
  - title: "从一个文件夹和想要的结果开始"
    details: "把 Kiki 指向代码库、一摞 PDF 与表格，或一份草稿。它先读材料、做计划，就在原地动手；在桌面应用、终端 `kiki` 或浏览器 `kiki web` 里开的会话，换个窗口打开还是它。"
    link: ./getting-started/first-launch
  - title: "一个主会话，调配不同模型的帮手"
    details: "活能拆开时，主智能体把子任务派给上下文隔离的子智能体——探查用快模型、写作或实现换另一个、审查再换一家厂商。每个子智能体的记录都能点开看，后台任务跑完会自动回来报到。"
    link: ./features/workbench
  - title: "每个角色就是一份可读可改的 Markdown"
    details: "每个 Agent Profile 是一份纯文本 Markdown：Frontmatter 定模型、思考档位、工具与可派发的子智能体，正文就是系统提示词。子智能体未绑模型会直接报 `model.not_configured`，不会悄悄继承昂贵模型。"
    link: ./features/agent-workflows
  - title: "跨轮次与跨会话推进长线工作"
    details: "用 `/goal` 让目标跨轮次留在视线里；趁它正忙先把消息排进队列，逐条选在空闲后、子智能体完成后或任务完成后送达；配合持有会话期间触发的定时提示词，以及可逐条撤销的分层记忆。"
    link: ./features/long-work
  - title: "有长期记忆的角色与多方讨论房间"
    details: "给常驻搭档一个名字、长期规则、独立记忆和固定的日常对话入口；或者把两到六个角色与现有会话拉进同一个房间，在主持人和发言预算下围绕一个议题碰撞。"
    link: ./features/people
  - title: "按需装上文档、表格、数据、浏览器与媒体"
    details: "当工作走出纯文本，可从目录安装对应插件：把本地 PDF 与 Office 提取成 Markdown（`Kiki Extract`）、读写 Word/Excel/PPT（`Kiki Office Suite`）、核对本地 CSV（`Kiki Work`）、查金融与文献数据、操作已登录浏览器或生成多模态素材。"
    link: ./features/extend
  - title: "提示词、工具描述与审批边界都能改"
    details: "内置提示词的任意具名字段都能按全局、模型或智能体替换，细到单独给某个模型改写一条工具描述；用 `kiki prompt-fields` 核对实际生效文本，并在手动、自动、替我审批与 YOLO 之间设定边界。"
    link: ./features/freedom
  - title: "看得见花了多少，也看得见谁被哪条规则拦住"
    details: "用量页直接标出挡住等待请求的那条并发规则；供应商未返回用量的调用标为未知而非伪装成 0；外部同步只发不含正文的统计数字，且必须由你预览载荷并同意后才启用。"
    link: ./features/daily
  - title: "跨空间、连手机，也接得进你现有的工具"
    details: "会话与凭据留在本机 Kiki home。支持分空间隔离工作与个人账号、绑微信或 QQ 在手机上回复和审批、把 Claude Code 或 Codex 的历史导进来接着聊，或通过 `kiki acp` 与 `kiki seat` 接入常用 IDE。"
    link: ./features/spaces
---
