# Kiki 截图巡览

一次一个能力地看 Kiki 工作台。[返回 README](../README.zh-CN.md) · [功能一览](features.zh-CN.md) · [在线功能一览 →](https://x-t-e-r.github.io/kiki/zh/features/)

## 工作台

整个窗口：左侧是会话列表，中间是正在进行的对话，右侧是派发树，底部是进行中的目标和一条排队消息。

![浅色主题下的 Kiki 工作台。](../docs/public/shots/index/hero-workbench.zh.png)

## 一个工作台，好几条线

派发树里每个角色各用各的模型：思考用 Astra xhigh，审查用 Fable，执行用 DeepSeek，探查用 GLM，都在同一个会话里。

![按角色绑定模型的派发树。](../docs/public/shots/workbench/workbench-per-role-models.zh.png)

点开任何一个派出去的子智能体，看它自己的对话记录：接到了什么、做了什么、结论是什么。

![子智能体的独立工作区，与主会话并排预览。](../docs/public/shots/workbench/d01-agent-preview.zh.png)

耗时的活转到后台任务：状态、输出、停止按钮都在。

![会话任务页，一个运行中的任务已展开。](../docs/public/shots/workbench/d03-tasks-page.zh.png)

## 长时间的活

定一个跨多轮推进的目标；它忙的时候，后续消息进队列，每条单独选发出时机。

![进行中的目标与带时机控制的消息队列。](../docs/public/shots/long-work/long-work-goal-queue.zh.png)

上下文窗口满了时，由你决定压缩点之后怎么办：压成摘要、只从工作笔记重启，还是每次由它自己判断。

![上下文用量表详情卡：压缩轨道与续上下文策略选中「清空重开」。](../docs/public/shots/long-work/long-work-context-fresh.zh.png)

记忆按全局、工作区或角色跨会话留住事实，每条都写明凭什么记，改动都能撤销。

![记忆页：三个范围、一条条目及其改动历史。](../docs/public/shots/long-work/long-work-memory-scopes.zh.png)

定时任务按 cron 往会话里投 prompt，只要还有 Kiki 进程持有那个已打开的会话就会触发；每条都能查看或取消。

![定时任务面板：周期、一次性和已暂停各一行。](../docs/public/shots/long-work/d05-cron-panel.zh.png)

装上可选的 `kiki-task-board` 插件后，每个工作区一块需求看板，不随会话结束而消失；卡片关联到正在处理它的会话。

![工作区任务看板。](../docs/public/shots/long-work/r04-task-board.zh.png)

![任务卡片详情与关联会话。](../docs/public/shots/long-work/board-task-detail.zh.png)

## 每天用的桌面

工具步骤折叠起来，完成通知留在时间线上随时可查。

![折叠的工具步骤与一条展开的后台任务完成通知。](../docs/public/shots/daily/d04-tool-steps-notification.zh.png)

用量页把一个日期区间拆成 token 和费用，两者各有独立的完整性指示。

![用量页的「历史」页签。](../docs/public/shots/daily/daily-usage.zh.png)

「实时」页签显示正在跑和正在等的请求，并写明是哪条并发规则挡着每一个等待中的请求——同一条规则就在下方，可以直接改。

![「实时」页签：一个等待中的请求，和决定它去留的并发规则。](../docs/public/shots/daily/ux-usage-live.zh.png)

外部同步把不含内容的统计发到 webhook、VibeCafe 账号，或你批准的脚本，并显示每个目的地自己的状态——包括一个凭据被拒、队列仍然保留的目的地。

![「外部同步」页签：webhook、VibeCafe 目的地和脚本，三种不同状态。](../docs/public/shots/daily/ux-usage-export.zh.png)

## 能一起干活的人

角色是带自己记忆的身份。角色卡给它起名、头像，写清它做什么用。

![角色编辑器：身份卡与它的长期规则。](../docs/public/shots/people/people-persona-card.zh.png)

点角色的名字每次都打开同一个对话，而它自己可以同时有多段。

![角色的日常对话，以及它的其它对话列表。](../docs/public/shots/people/people-daily-conversation.zh.png)

房间里，两到六个角色按顺序讨论同一个话题，有主持人也有预算。

![一个房间，三个角色在讨论一次发布，每条发言都标着是谁说的。](../docs/public/shots/people/people-room.zh.png)

## 数据与机器都在你手上

空间就是你要打开的某一个 Kiki，每个子空间自己决定与主空间共享凭据还是独立保留。

![空间列表，以及某个子空间的凭据范围。](../docs/public/shots/spaces/spaces-spaces-list.zh.png)

远端连接把一个 Kiki home 指向另一个，目标批准来源之后才有东西流过去。

![远端连接列表：一条已连接的 home 与它的操作。](../docs/public/shots/spaces/spaces-remote-connections.zh.png)

Web 访问用一条一次性链接把这个 Kiki 开给另一台设备上的浏览器。

![Web 访问已开启，列出模式与已登录的浏览器。](../docs/public/shots/spaces/spaces-web-access.zh.png)

## 每一层都归你

每个智能体都是一份 Markdown 文件。在设置里可以直接看和改原文：来源路径、frontmatter 绑定、系统提示词都在。

![在设置中编辑子智能体的 Markdown 原文。](../docs/public/shots/agents/r01-reviewer-profile.zh.png)

内置提示词的每个字段都能覆写，预览里实时显示模型会看到什么。

![带渲染预览的提示词字段覆写。](../docs/public/shots/freedom/d02-prompt-fields.zh.png)

Kiki 触达模型的每一种方式都是一张列表里的一行，怎么认证也是这一行自身的事。

![连接列表：已登录与已过期的行并排显示。](../docs/public/shots/freedom/freedom-connections.zh.png)

## 带过来，也接得进外面

别的工具的对话可以变成能接着做的 Kiki 会话，预览会写明保留什么、不保留什么。

![历史导入预览：列出各个来源与这次导入会丢掉什么。](../docs/public/shots/ecosystem/ecosystem-history-import.zh.png)

## 在网上找东西

联网搜索和抓取走可以查看的具名通道，部分通道不用密钥。

![搜索通道及其就绪状态与原因。](../docs/public/shots/extend/d06-search-lanes.zh.png)

![带回退的抓取提取链。](../docs/public/shots/extend/d07-fetch-chain.zh.png)

把录屏拖进对话，智能体和你一起看。

![会话中内联播放的视频附件。](../docs/public/shots/daily/d08-video-attachment.zh.png)
