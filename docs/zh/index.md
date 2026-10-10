---
layout: home
hero:
  name: Kiki
  text: 你的智能体，你说了算。
  tagline: 把一个文件夹和一件事交给它，它做计划、把活干完，还能让工作持续下去——开源，跑在你自己的机器上，桌面、终端、浏览器共用一个本地守护进程。
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
  - title: 先做一件事
    details: 选好它在哪个文件夹里工作、读哪些材料，再把任务交给它。欢迎页和「发现 Kiki」带你认路，全程不调用模型。
    link: ./getting-started/first-launch
  - title: 一个工作台，好几条线
    details: 主会话派子智能体，每个智能体跑你为它选定的模型；耗时命令丢进后台，跑完自动回报。
    link: ./features/workbench
  - title: 知道花了多少
    details: 用量页回答三个问题：这个区间花了多少、是哪条并发规则挡住了请求、这些不含内容的统计能送到哪儿。
    link: ./features/daily
  - title: 长时间的活
    details: 跨轮次推进的目标、它忙时你先排的队、定时提示词、每个工作区一块任务看板，以及比会话活得更久的记忆。
    link: ./features/long-work
  - title: Agent Profiles
    details: 一份 Markdown 描述一类智能体：跑哪个模型、怎么指示、能用哪些工具、能派发谁，写一次到处复用。
    link: ./features/agents
  - title: 能一起干活的人
    details: 角色是长期身份：有自己的记忆、固定的日常对话入口，还能进房间和别的角色一起讨论同一个话题。
    link: ./features/people
  - title: 每一层都归你
    details: 提示词细到单个工具描述，连接和 OAuth 一张列表，权限模式你定，hooks 跑你自己的脚本。
    link: ./features/freedom
  - title: 数据与机器都在你手上
    details: 各自带凭据的空间、有方向的远端连接、单向 thread bridge、Web 访问，以及会话内 SSH。
    link: ./features/spaces
  - title: 带过来，也接得进外面
    details: 把别的工具的对话导进来接着做，在编辑器里通过 ACP 用 Kiki，或者让 Kiki 把别的智能体 harness 当引擎。
    link: ./features/ecosystem
---
