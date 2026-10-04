---
title: 扩展
---

# 扩展

在智能体本身具备的模型、提示词和工具之外，Kiki 还有四条扩展缝：**插件**用来打包能力，**Skill** 用来加入可复用的工作流，**MCP 服务器**用来连接外部工具，还有面向网页的**搜索与抓取**。这一页分别讲这四样，以及它们之间的区别——因为插件、Skill 和 MCP 服务器听起来像，其实不是。

## 插件把能力打包

插件是打包单位。一个插件可以贡献 Skill、智能体、MCP 服务器、hooks、命令、工具和沙箱面板，你可以在**能力**页浏览、安装和配置。带 `.claude-plugin/plugin.json` 清单的 Claude Code 插件也能装，还可以让 Kiki 指向你自己的市场 JSON。

官方市场由 Kimi 维护，目前有三条：**Kimi Datasource**（用自然语言查市场行情、宏观指标、企业注册、学术文献和法律法规）、**Kimi Browser Extension**（让 AI 驱动你自己的浏览器）、**Kimi Computer Use**（让 AI 操作你的桌面应用）。另外两个能力是独立插件，不属于这三条：**Kiki Documents** 把本地 PDF、Office、HTML 或文本文件转成 `Read` 和 `Grep` 能用的 Markdown；**Kiki Notion** 是面向 Notion 官方托管 MCP 服务的配置和工作流。安装插件本身不会执行它的 hooks——只有匹配的事件发生、且插件处于启用状态时才会触发。见[插件](/zh/customization/plugins)。

媒体生成是另一项独立的能力：媒体插件贡献一到多个图片、视频或语音的**来源**，在**能力 → 插件 → 媒体来源**里配置。生成功能**默认关闭**，需要显式打开；这是一项按需启用的能力，不是默认行为。

## Skill 是可复用的工作流

[Agent Skill](/zh/customization/skills)是一份 Markdown 文件，注入专门的工作流或知识体系，智能体在相关时候会调用它；它同时注册成一个你可以用 `/名字` 亲自触发的斜杠命令。在提示词里空白后点名多个 Skill，Kiki 会一起激活，作为同一轮运行（只有一次 `/undo`，撤销的是整次提交），提示词原文照发。也可以用 `/skill:<名字>` 显式调用，资源（脚本、参考）就放在 Skill 文件旁边。

**自定义提示命令**是它的轻量版：只是一段你自己用 `/名字` 触发的提示词，不牵涉智能体。见 [Agent Skills](/zh/customization/skills)和[自定义提示命令](/zh/customization/skills#自定义提示命令)。

## MCP 服务器连接外部工具

[Model Context Protocol](/zh/server/mcp)服务器让智能体调用外部进程或服务暴露的工具——数据库、GitHub 工单系统、本地文件系统。Kiki 作为 MCP 客户端支持三种接入方式：**stdio**（Kiki 把服务器作为子进程启动）、**HTTP**（已在运行的端点）和 **SSE**（旧式流式传输；新服务器优先用 HTTP）。在用户级（`~/.kiki/mcp.json`）或项目级（`.kiki/mcp.json`）的 `mcp.json` 里配置，用 `/kiki-ops help me configure MCP` 交互式增删改，用 `/mcp` 查看连接状态。未受信文件夹里的项目级 MCP 服务器，会在信任提示里列出它的接入方式和启动目标——信任文件夹之前先读一遍。

MCP 工具到达智能体时与内置工具完全一样，走同一套审批模型。见 [Model Context Protocol](/zh/server/mcp)。

## 搜索与抓取

`WebSearch` 和 `FetchURL` 由一个可查看的搜索与抓取模块支撑。**设置 → 搜索与抓取 → 概览与来源**显示当前生效的是哪个配置来源、服务端是否复用了你本机的搜索配置；具名通道的就绪状态也能在那里看到。搜索跑在具名通道上——其中一些（比如 GitHub 仓库搜索）不需要密钥，同一供应商配了多个密钥时会在调用之间轮换。抓取走一条带回退的链路，你能看出是哪个提取器产出了文本。等价配置在 `config.toml` 的 `nb_search` 下。见[搜索与抓取](/zh/guides/settings#搜索与抓取)和[配置文件 `nb_search`](/zh/configuration/config-files#nb-search)。

## 下一步

- [插件](/zh/customization/plugins)——完整的插件参考
- [Agent Skills](/zh/customization/skills)——写一个 Skill
- [Model Context Protocol](/zh/server/mcp)——连接 MCP 服务器
