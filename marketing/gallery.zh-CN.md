# Kiki 截图巡览

你的智能体，你说了算。Kiki 是跑在你自己机器上的开源 AI 智能体工作台。[返回 README](../README.zh-CN.md) · [功能一览](features.zh-CN.md)。

*以下场景均由真实 Kiki 界面在示例项目上渲染，展示的是界面，不代表模型性能实测。*

## 工作台

整个窗口：左侧是会话列表，中间是正在进行的对话，右侧是派发树，底部是进行中的目标和一条排队消息。

![浅色主题下的 Kiki 工作台。](shots/h01-fleet-workbench.zh.light.png)

## 自由：每一层都归你

每个角色各用各的模型：思考用 Astra xhigh，审查用 Fable，执行用 DeepSeek，探查用 GLM，都在同一个会话里。

![按角色绑定模型的派发树。](shots/r05-multi-model-fleet.zh.light.png)

每个智能体都是一份 Markdown 文件。在设置里可以直接看和改原文：来源路径、frontmatter 绑定、系统提示词都在。

![在设置中编辑子智能体的 Markdown 原文。](shots/r01-reviewer-profile.zh.light.png)

内置提示词的每个字段都能覆写，预览里实时显示模型会看到什么。

![带渲染预览的提示词字段覆写。](shots/d02-prompt-fields.zh.light.png)

## 强大：扛得住长时间、多条线并行的活

点开任何一个派出去的子智能体，看它自己的对话记录：接到了什么、做了什么、结论是什么。

![子智能体的独立工作区，与主会话并排预览。](shots/d01-agent-preview.zh.light.png)

耗时的活转到后台任务：状态、输出、停止按钮都在。

![会话任务页，一个运行中的任务已展开。](shots/d03-tasks-page.zh.light.png)

工具步骤折叠起来，完成通知留在时间线上随时可查。

![折叠的工具步骤与一条展开的后台任务完成通知。](shots/d04-tool-steps-notification.zh.light.png)

定一个跨多轮推进的目标；它忙的时候，后续消息进队列，每条单独选发出时机。

![进行中的目标与带时机控制的消息队列。](shots/r02-goal-queue.zh.light.png)

定时任务按 cron 往会话里投 prompt，可以查看、暂停，也能手动触发。

![定时任务面板：周期、一次性和已暂停各一行。](shots/d05-cron-panel.zh.light.png)

每个工作区一块需求看板，不随会话结束而消失；卡片关联到正在处理它的会话。

![工作区任务看板。](shots/r04-task-board.zh.light.png)

![任务卡片详情与关联会话。](shots/board-task-detail.zh.light.png)

联网搜索和抓取走可以查看状态的命名通道，部分通道不用密钥。

![搜索通道及其就绪状态与原因。](shots/d06-search-lanes.zh.light.png)

![带回退的抓取提取链。](shots/d07-fetch-chain.zh.light.png)

把录屏拖进对话，智能体和你一起看。

![会话中内联播放的视频附件。](shots/d08-video-attachment.zh.light.png)
