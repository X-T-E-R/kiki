# V2EX（分享创造）草稿

**节点：** 分享创造

**标题：** 一个任务里同时用几家模型是什么体验：开源本地智能体工作台 Kiki（MIT）

**正文：**

一个任务里同时用几家模型是什么体验。一件事，几家模型分工做。你的智能体，你说了算。

Kiki 是一个开源（MIT）的本地智能体工作台，作为服务跑在你自己的机器上，桌面应用、终端（`kiki`）、浏览器（`kiki web`）和手机看到的是同一场工作：https://github.com/X-T-E-R/kiki

平时写代码或做跨文件改动时，我不想把探查、实现、审查全塞给一个贵模型，也不想换模型就得重开会话。在 Kiki 里，主会话把活拆开，强模型负责规划和验收，日常或范围清楚的活交给便宜模型，审查再换另一家厂商：

- **按角色混编不同厂商的模型。** 主智能体通过 `AgentRun` 派出上下文隔离的子智能体，比如 `explore` 走快模型只读探查、`implementer` 用 DeepSeek / GLM 改代码、独立 `reviewer` 换另一家厂商审 diff。每个子智能体是一份纯文本 Markdown（frontmatter 写工具、`model_alias`、思考档位和允许派发的子角色，正文是系统提示词），改完下次派发立即生效，正在跑的会话保留启动快照直到点「重建上下文」。如果某个子智能体没绑模型也没配 `[subagent].default_model`，派发会直接报 `model.not_configured`，不会悄悄回退去烧主会话的贵模型。
- **每个模型都有自己的专武。** Claude Code 是照着 Claude 调的，Codex 是照着 GPT 调的；Kiki 通过配方（Recipe）给接进来的原生模型单独调——Recipe 把可复用的提示词、模型设置和可选脚本 Hook 打包在一起，安装一次，绑在单个模型上，每个绑定还能单独开关选项。作者已经在公开仓库 https://github.com/X-T-E-R/kiki-recipes （MIT）发布了五套，分别给 GPT-6.1 Sol（主模型先想清意图和完成标准，收尾带判断与品味）、GPT-6 Astra（在 Astra 上沿用同一套主从分工）、DeepSeek V4.1（面向思考偏浅、字面执行的模型，动手前先推演机理与反例）、Gemini 4 Argon（在 Argon 上带主模型审美层与契约内子智能体质量层）和 Gemini 3.8 Flash（高频小模型，写作、前端与有界杂活先锚定样板）。我觉得每个模型就像一个性格不同的孩子，作者也算是哄好了好几个脾气各异的模型——比如把 DeepSeek V4.1 哄到先推演机理和反例再动手。这些 Recipe 只作用于 Kiki 原生运行的模型，不作用于 Claude Code 或 Codex 作为外部执行器跑的回合。
- **提示词细到单个工具描述都能按模型覆写。** 便宜模型用错内置工具时，可以在 `config.toml` 按「全局 → 模型 → 智能体」覆写任意具名字段（比如只给某个模型改写 `tool.web-search.description`），跑 `kiki prompt-fields explain <字段> --model <别名>` 就能核对生效文本和完整来源链。
- **长线任务与更多能力。** 耗时命令和子智能体丢到后台，跑完自动通知主智能体，不用轮询；它忙的时候你发的消息进队列，每条可单选「空闲后 / 子智能体完成后 / 任务完成后」送达。工作文件留在原目录，会话、历史和配置存在本机 Kiki home，模型请求只发往你自己连接的供应商或本地服务。其余还支持 `/goal` 跨轮次目标、可逐条撤销的分层记忆、可选插件（`kiki-task-board` 看板、拆本地 PDF/Office 的 `Kiki Extract`、Word/Excel/PPT 的 `Kiki Office Suite`、本地 CSV 核对的 `Kiki Work`）、跨空间隔离、会话内 SSH、微信/QQ 手机审批、历史对话导入，以及通过 `kiki acp` / `kiki seat` 接入 IDE 和外部客户端。

说明与限制：当前处于 `0.x`（公开发布版本 `0.5.1`），细节还在打磨；macOS 安装包未签名也未公证；Windows 首次运行需先装 Git for Windows；npm 安装需 Node.js 24.22.1+ 或 26.12.1+。仓库里的截图由真实界面渲染的示例场景（`docs/public/shots/`），不代表性能跑分。项目最初 fork 自 Kimi Code，现独立开发。

[图：docs/public/shots/workbench/workbench-per-role-models.zh.png（多模型派发树，示例画面）]
[图：docs/public/shots/freedom/d02-prompt-fields.zh.png（提示词字段覆写，示例画面）]

想和大家交流：你在混用强模型和便宜模型时，最想单独给哪个模型写一份配方或改哪条工具描述。
