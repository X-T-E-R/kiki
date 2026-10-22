---
layout: home
hero:
  name: Kiki
  text: 把一个文件夹和一件事交给它。
  tagline: 跑在你自己机器上的开源 AI 智能体工作台。查资料、写长文、处理文档与表格、改代码都能交出去——主智能体按角色调度不同厂商的模型、把耗时任务丢进后台，并把记忆和需求跨会话留存下来。
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
  - title: 从一个文件夹和一件事开始
    details: 把 Kiki 指向代码库、一堆 PDF 文献或草稿目录。桌面应用、终端（`kiki`）和浏览器（`kiki web`）共用同一个本地守护进程；欢迎导览与起步建议全程不调用模型。
    link: ./getting-started/first-launch
  - title: 一个主会话，带一队不同模型的帮手
    details: 主智能体把大活拆给上下文隔离的子智能体——探查用快模型、写作或实现换另一个、审查再换一家厂商——耗时任务转入后台，跑完自动通知主智能体，不用你在窗口间来回切换。
    link: ./features/workbench
  - title: 一份 Markdown 就是一个可复用的智能体
    details: 每个 Agent Profile 都是一份纯文本 Markdown：Frontmatter 定模型、思考档位、工具与可派发对象，正文就是系统提示词。保存后约 200 ms 自动热重载，现有的 Claude Code 或 OpenCode agent 文件放进来就能用。
    link: ./features/agent-workflows
  - title: 跨几小时、几天的活不会断
    details: 用 `/goal` 让目标跨多轮持续推进；趁它正忙先发消息进队列，并逐条指定在空闲后、子智能体完成后或任务完成后送达；配合定时任务、工作区需求看板与可逐条撤销的跨会话记忆。
    link: ./features/long-work
  - title: 叫得出名字的长期角色与讨论房间
    details: 给常驻协作者一个名字、长期规则、独立记忆和每次点击都回到的日常对话入口；或者把两到六个角色与现有会话拉进同一个房间，在主持人和发言预算下围绕一个议题碰撞结论。
    link: ./features/people
  - title: 本地文档、数据查询、浏览器与多模态
    details: 把本地 PDF、Word、Excel、PPT 提取成可检索的 Markdown，配合写作与办公套件、金融与学术自然语言查询、复用你已登录浏览器的网页操作、桌面软件操控，以及图片、视频与语音生成。
    link: ./features/extend
  - title: 细到单个工具描述的提示词与权限控制
    details: 内置提示词的任意具名字段都能按全局、模型或智能体覆写，细到单独给某个便宜模型改写一条工具描述；用 `kiki prompt-fields` 查看实际生效文本，并在手动、自动、替我审批与 YOLO 之间自定边界。
    link: ./features/freedom
  - title: 看得见谁在排队，算得清真实花费
    details: 用量页实时标出哪条并发规则挡住了等待中的请求；统计历史费用时把未上报用量的调用单独标为未知而非伪装成 0；外部同步只发不含正文的纯数字，且必须由你预览载荷并同意后才启用。
    link: ./features/daily
  - title: 跨空间、跨机器、连手机，也接得进现有工具
    details: 用空间隔离工作与个人凭据，连接远端 Kiki、单向 thread bridge 或会话内 SSH，绑微信或 QQ 在手机上回复和审批；还能把 Claude Code、Codex 等历史对话导进来接着做，或通过 ACP 与 MCP 席位接入常用 IDE。
    link: ./features/spaces
---
