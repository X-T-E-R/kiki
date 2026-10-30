---
title: 插件、Skill、MCP 与搜索
---

# 插件、Skill、MCP 与搜索

在智能体本身具备的模型、提示词和工具之外，Kiki 还有四条扩展缝：**插件**用来打包能力，**Skill** 用来加入可复用的工作流，**MCP 服务器**用来连接外部工具，还有面向网页的**搜索与抓取**。这一页分别讲这四样，以及它们之间的区别——因为插件、Skill 和 MCP 服务器听起来像，其实不是。

## 官方与精选插件

插件是打包单位。一个插件可以贡献 Skill、智能体、MCP 服务器、hooks、命令、工具和沙箱面板，你可以在**能力 → 扩展与工具**里浏览、安装和配置。带 `.claude-plugin/plugin.json` 清单的 Claude Code 插件也能装，还可以让 Kiki 指向你自己的市场 JSON。

目录就是 **Official** 页签：Kiki 自建插件与 Kimi 维护的上游条目并列，按任务需要逐个安装。

- **Kiki Extract** 把本地 PDF、Office、HTML 或文本文件转成 `Read` 和 `Grep` 能用的 Markdown。这是一次读取动作：原件既不会被创建也不会被修改，处理 PDF 或 Office 需要运行 Kiki 的机器上备好 Python 与 MarkItDown。
- **Kiki Office Suite** 在本机创建和编辑 Word、Excel、PowerPoint 文件。
- **Kiki Work** 在本机核对 CSV/TSV 键并对照两张表，不改原件也不上传。
- **Kiki Writing** 提供专注的手稿面板与续写草稿命令。
- **Kiki Notion** 连接 Notion 官方托管 MCP 服务，只写回你点名的页面。
- **Task board**（`kiki-task-board`）为每个工作区保存需求卡片，并关联到正在处理它的会话。
- **Cloudflare Tunnel** 和 **Kiki Sites** 负责把本地服务开出去或部署站点。
- **Kimi Datasource** 用自然语言查行情、宏观指标、企业工商、学术文献与中文法律法规；需要先用 Kimi Code OAuth 登录，查询会消耗套餐额度。
- **Kimi Browser Extension** 驱动你已经在用的浏览器，需要在扩展商店安装配套扩展并在那里批准。

浏览器控制与电脑控制是专门的系统级能力：除了 Kimi 浏览器扩展，Kiki 也支持自管独立浏览器、附着已有 CDP 浏览器、接入 Ego Lite，以及通过内置执行器或 **Kimi Computer Use** 插件控制桌面。完整介绍见 [浏览器与电脑控制](/zh/features/browser-and-computer) 与 [设置页导览：浏览器控制](/zh/guides/settings#浏览器控制)。

每个插件各自安装、配置和启用。安装插件本身不会执行它的 hooks——只有匹配的事件发生、且插件处于启用状态时才会触发。见[插件](/zh/customization/plugins)。

媒体生成使用媒体插件提供的图片、视频或语音**来源**，在**能力 → 扩展与工具 → 插件 → 媒体来源**里配置。无需额外的实验开关：安装并启用插件、配置并启用来源后，按需发起生成。保存或列出来源不会启动任务。来源访问与授权见 [媒体来源](/zh/customization/plugins#媒体来源)。

## Agent Skills 工作流

[Agent Skill](/zh/customization/skills)是一份 Markdown 文件，注入专门的工作流或知识体系，智能体在相关时候会调用它；它同时注册成一个你可以用 `/名字` 亲自触发的斜杠命令。在提示词里空白后点名多个 Skill，Kiki 会一起激活，作为同一轮运行（只有一次 `/undo`，撤销的是整次提交），提示词原文照发。也可以用 `/skill:<名字>` 显式调用，资源（脚本、参考）就放在 Skill 文件旁边。

**自定义提示命令**是它的轻量版：只是一段你自己用 `/名字` 触发的提示词，不牵涉智能体。见 [Agent Skills](/zh/customization/skills)和[自定义提示命令](/zh/customization/skills#自定义提示命令)。

## MCP 服务器

[Model Context Protocol](/zh/server/mcp)服务器让智能体调用外部进程或服务暴露的工具——数据库、GitHub 工单系统、本地文件系统。Kiki 作为 MCP 客户端支持三种接入方式：**stdio**（Kiki 把服务器作为子进程启动）、**HTTP**（已在运行的端点）和 **SSE**（旧式流式传输；新服务器优先用 HTTP）。在用户级（`$KIKI_HOME/mcp.json`；默认 `~/.kiki/mcp.json`）或项目级（`.kiki/mcp.json`）的 `mcp.json` 里配置，用 `/kiki-ops help me configure MCP` 交互式增删改，用 `/mcp` 查看连接状态。未受信文件夹里的项目级 MCP 服务器，会在信任提示里列出它的接入方式和启动目标——信任文件夹之前先读一遍。

MCP 工具到达智能体时与内置工具完全一样，走同一套审批模型。见 [Model Context Protocol](/zh/server/mcp)。

## 搜索与抓取

用 `WebSearch` 搜索网页，用 `FetchURL` 读取页面正文——两者由同一个可查看的搜索与抓取模块支撑。**设置 → 搜索与抓取 → 概览与配置来源**显示当前生效的是哪个配置来源、服务端是否复用了你本机的搜索配置；具名通道的就绪状态也能在那里看到。搜索跑在具名通道上——其中一些（比如 GitHub 仓库搜索）不需要密钥，同一供应商配了多个密钥时会在调用之间轮换。抓取走一条带回退的链路，你能看出是哪个提取器产出了文本。等价配置在 `config.toml` 的 `nb_search` 下。见[搜索与抓取](/zh/guides/settings#搜索与抓取)和[配置文件 `nb_search`](/zh/configuration/config-files#nb-search)。

![搜索通道页签：默认通道、已固定的通道，以及其余每条通道的结果与凭据来自哪里。](/shots/extend/ce-20261005-extend-search-lanes.zh.png)

![抓取链路页签：一个网址按顺序经过哪些提取器，以及每一级回退到哪里。](/shots/extend/ce-20261005-extend-fetch-chain.zh.png)

## 下一步

- [插件](/zh/customization/plugins)——完整的插件参考
- [Agent Skills](/zh/customization/skills)——写一个 Skill
- [Model Context Protocol](/zh/server/mcp)——连接 MCP 服务器
- [浏览器与电脑控制](/zh/features/browser-and-computer)——驱动浏览器与桌面图形界面应用
