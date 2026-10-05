# Kiki 截图巡览

一次一个能力地看 Kiki 工作台。[返回 README](../README.zh-CN.md) · [功能一览](features.zh-CN.md) · [在线功能一览 →](https://x-t-e-r.github.io/kiki/zh/features/)

## 工作台

整个窗口：左侧是会话列表，中间是正在进行的对话，右侧是派发树，底部是进行中的目标和一条排队消息。

![浅色主题下的 Kiki 工作台。](shots/h01-fleet-workbench.zh.light.png)

## 一个工作台，好几条线

派发树里每个角色各用各的模型：思考用 Astra xhigh，审查用 Fable，执行用 DeepSeek，探查用 GLM，都在同一个会话里。

![按角色绑定模型的派发树。](shots/r05-multi-model-fleet.zh.light.png)

点开任何一个派出去的子智能体，看它自己的对话记录：接到了什么、做了什么、结论是什么。

![子智能体的独立工作区，与主会话并排预览。](shots/d01-agent-preview.zh.light.png)

耗时的活转到后台任务：状态、输出、停止按钮都在。

![会话任务页，一个运行中的任务已展开。](shots/d03-tasks-page.zh.light.png)

## 长时间的活

定一个跨多轮推进的目标；它忙的时候，后续消息进队列，每条单独选发出时机。

![进行中的目标与带时机控制的消息队列。](shots/r02-goal-queue.zh.light.png)

上下文窗口满了时，由你决定压缩点之后怎么办：压成摘要、只从工作笔记重启，还是每次由它自己判断。

![上下文用量表详情卡：压缩轨道与续上下文策略选中「清空重开」。](shots/long-work-context-fresh.zh.light.png)

记忆按全局、工作区或角色跨会话留住事实，每次改动都能撤销。

![记忆页：三个范围、一条条目及其改动历史。](shots/long-work-memory-scopes.zh.light.png)

定时任务按 cron 往会话里投 prompt，只要还有 Kiki 进程持有那个已打开的会话就会触发；每条都能查看或取消。

![定时任务面板：周期、一次性和已暂停各一行。](shots/d05-cron-panel.zh.light.png)

每个工作区一块需求看板，不随会话结束而消失；卡片关联到正在处理它的会话。

![工作区任务看板。](shots/r04-task-board.zh.light.png)

![任务卡片详情与关联会话。](shots/board-task-detail.zh.light.png)

## 每天用的桌面

工具步骤折叠起来，完成通知留在时间线上随时可查。

![折叠的工具步骤与一条展开的后台任务完成通知。](shots/d04-tool-steps-notification.zh.light.png)

用量页把一个日期区间拆成 token 和费用，两者各有独立的完整性指示。

![用量页的「历史」页签。](shots/daily-usage.zh.light.png)

## 能一起干活的人

角色是带自己记忆的身份。角色卡给它起名、头像，写清它做什么用。

![角色编辑器：身份卡与它的长期规则。](shots/people-persona-card.zh.light.png)

点角色的名字每次都打开同一个对话，而它自己可以同时有多段。

![角色的日常对话，以及它的其它对话列表。](shots/people-daily-conversation.zh.light.png)

房间里，两到六个角色按顺序讨论同一个话题，有主持人也有预算。

![一个房间，三个角色在讨论一次发布，每条发言都标着是谁说的。](shots/people-room.zh.light.png)

## 数据与机器都在你手上

空间就是你要打开的某一个 Kiki，每个子空间自己决定与主空间共享凭据还是独立保留。

![空间列表，以及某个子空间的凭据范围。](shots/spaces-spaces-list.zh.light.png)

远端连接把一个 Kiki home 指向另一个，目标批准来源之后才有东西流过去。

![远端连接列表：一条已连接的 home 与它的操作。](shots/spaces-remote-connections.zh.light.png)

Web 访问用一条一次性链接把这个 Kiki 开给另一台设备上的浏览器。

![Web 访问已开启，列出模式与已登录的浏览器。](shots/spaces-web-access.zh.light.png)

## 每一层都归你

每个智能体都是一份 Markdown 文件。在设置里可以直接看和改原文：来源路径、frontmatter 绑定、系统提示词都在。

![在设置中编辑子智能体的 Markdown 原文。](shots/r01-reviewer-profile.zh.light.png)

内置提示词的每个字段都能覆写，预览里实时显示模型会看到什么。

![带渲染预览的提示词字段覆写。](shots/d02-prompt-fields.zh.light.png)

Kiki 触达模型的每一种方式都是一张列表里的一行，怎么认证也是这一行自身的事。

![连接列表：已登录与已过期的行并排显示。](shots/freedom-connections.zh.light.png)

## 带过来，也接得进外面

别的工具的对话可以变成能接着做的 Kiki 会话，预览会写明保留什么、不保留什么。

![历史导入预览：列出各个来源与这次导入会丢掉什么。](shots/ecosystem-history-import.zh.light.png)

## 在网上找东西

联网搜索和抓取走可以查看的具名通道，部分通道不用密钥。

![搜索通道及其就绪状态与原因。](shots/d06-search-lanes.zh.light.png)

![带回退的抓取提取链。](shots/d07-fetch-chain.zh.light.png)

把录屏拖进对话，智能体和你一起看。

![会话中内联播放的视频附件。](shots/d08-video-attachment.zh.light.png)
