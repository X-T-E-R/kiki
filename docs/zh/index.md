---
layout: home
hero:
  name: Kiki
  text: 你的智能体，你说了算。
  tagline: 跑在你自己机器上的开源 AI 智能体工作台，桌面、终端、浏览器共用一个本地守护进程
  actions:
    - theme: brand
      text: 快速上手
      link: ./getting-started/installation
    - theme: alt
      text: 全部功能
      link: https://github.com/X-T-E-R/kiki/blob/kiki/marketing/features.zh-CN.md
    - theme: alt
      text: 发布说明
      link: ./release-notes/changelog
features:
  - title: 自由：每个角色各用各的模型
    details: 每个角色单独绑模型，不同厂商混着用。海外前沿模型做规划，DeepSeek、GLM 跑日常的活，审查再换一家。
    link: ./customization/agents
  - title: 自由：智能体就是你的文件
    details: 一份 Markdown，frontmatter 写工具、模型和能派发谁。Claude Code、OpenCode 的 agent 文件直接能用，改完约 200ms 生效。
    link: ./customization/agent-profiles
  - title: 自由：提示词随便改
    details: 内置提示词可以改到单个工具的描述，全局、按模型、按智能体都行；用 kiki prompt-fields 看模型最终收到了什么。
    link: ./customization/prompt-fields
  - title: 强大：好几条线同时推进
    details: 主智能体自己派子智能体、开后台任务，跑完会自动通知它。
    link: ./reference/tools#后台任务
  - title: 强大：它忙的时候你照样能说话
    details: 消息先进队列，每条可以单独选什么时候发：空闲后、子智能体完成后，或任务完成后。
    link: ./guides/interface#输入框
  - title: 强大：活不随会话结束而丢
    details: 智能体能读写的工作区需求看板、跨多轮推进的目标，以及按 cron 定时投递的任务。
    link: ./guides/sessions#需求看板
---
