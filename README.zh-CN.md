# Kiki

**你的智能体，你说了算。**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/zh/) <br>
[文档](https://x-t-e-r.github.io/kiki/zh/) · [功能一览](marketing/features.zh-CN.md) · [截图巡览](marketing/gallery.zh-CN.md) · [问题反馈](https://github.com/X-T-E-R/kiki/issues) · [致谢](ACKNOWLEDGEMENTS.zh-CN.md) · [English](README.md)

Kiki 是一个开源的 AI 智能体工作台，跑在你自己的机器上。桌面应用、终端界面和浏览器界面连的是同一个本地守护进程，所以同一批会话在哪儿都能打开。

常见用法：

- 把编码或调研任务交给主智能体，由它拆给多个子智能体，每个角色跑你为它选定的模型。
- 让长任务持续推进：跨多轮的目标、它忙时你说的话先排队、定时投递的提示词，以及每个工作区一块任务看板。
- 精确控制每个智能体看到什么，从工具和模型，细到单个工具描述的措辞。

<!-- 主图：主会话调度多条线的真实录屏（见 marketing/launch/demo-storyboard.md）录好后替换。 -->
![Kiki 工作台：主会话和它派出的子智能体、一个后台任务、进行中的目标，以及一条排队消息。](marketing/shots/h01-fleet-workbench.zh.light.png)

*示例场景由真实 Kiki 界面渲染，不代表模型性能实测；之后会换成真实录屏。*

## 一分钟上手

```sh
npm install -g kiki-agent   # 需要 Node.js 24.15.0+；也可以直接下载下方的桌面版
cd your-project
kiki                        # 终端界面；`kiki web` 打开浏览器界面，`kiki desktop` 打开桌面应用
```

运行 `/login`，选择 Kimi Code OAuth 或 Kimi 开放平台 API 密钥（接入其他供应商见[平台与模型](https://x-t-e-r.github.io/kiki/zh/configuration/providers)）。然后试一句：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

新会话默认是「自动」模式：日常操作直接执行，碰到敏感文件或危险命令仍会先问你。用 `/permission` 在手动、自动、审查和 YOLO 之间切换。Windows 用户请先装好 Git for Windows（见下文）。

## 安装

从 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 的 `kiki-v<版本号>` 选择构建：

| 平台 | 桌面应用 | 独立 CLI/TUI |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe`（同时把 `kiki` 加到用户 `PATH`） | 已包含在安装包里，不另发 Windows CLI 文件 |
| Linux x64 | `Kiki_*_amd64.deb`（安装 `kiki` 命令）或 `Kiki_*_amd64.AppImage` | `kiki-linux-x64` |
| Linux ARM64 | — | `kiki-linux-arm64` |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | `kiki-darwin-arm64` |
| macOS Intel | `Kiki_*_x64.dmg` | `kiki-darwin-x64` |

独立 CLI 文件附带对应的 `.sha256` 校验文件。macOS 的 dmg 未签名、未公证：先校验下载，拖入「应用程序」，首次启动用 **按住 Control 键点按 → 打开**。dmg 不会更改 `PATH`，CLI 需单独添加。

npm 安装：`kiki-agent` 包含 CLI/TUI，安装时会从 GitHub 下载对应的桌面构建并校验 SHA-256（需要联网）；`kiki-agent-lite` 只装 CLI/TUI。`kiki desktop` 可打开已安装的桌面应用，未安装时会提示获取方式。

> 在 Windows 上，首次启动前请先安装 [Git for Windows](https://gitforwindows.org/)，因为 Kiki CLI 使用自带的 Git Bash 作为 shell 环境。如果 Git Bash 安装在自定义位置，请将 `KIKI_SHELL_PATH` 设置为 `bash.exe` 的绝对路径。

新开终端运行 `kiki --version` 验证。校验命令和更新通道见[安装](https://x-t-e-r.github.io/kiki/zh/getting-started/installation)。

## 智能体与模型

- **每个角色单独绑模型。** 主智能体、各个子智能体和审查者可以绑不同的模型，同一个会话里混用多家厂商。Kimi 开箱即用；Anthropic、OpenAI 兼容服务、OpenAI Responses API、Gemini 和 Vertex AI 都能接，也可以用 GitHub Copilot 或 ChatGPT 账号登录。
- **智能体就是你自己的 Markdown 文件。** frontmatter 写工具、模型、思考强度和能派发谁，正文就是系统提示词。Kiki 会监视智能体目录，改完约 200ms 自动重载。frontmatter 的字段是封闭的：Claude Code 或 OpenCode 的 agent 文件，删掉 Kiki 不认识的字段（比如 Claude Code 的 `model`、OpenCode 的 `mode`）就能加载。
- **提示词细到单个工具描述。** 内置提示词的任意字段都能改，可以全局改，也可以按模型、按智能体单独改。`kiki prompt-fields list | show | explain` 能看到模型最终收到了什么、每个值来自哪一层。
- **子智能体做完会回报。** 主智能体自己派子智能体、把耗时命令转到后台，完成后会收到通知，不用反复去查。任何子智能体的记录都能打开，也能在它自己的输入框里给它发消息。
- **隔离的 worktree。** 新建会话时选一个 git worktree，这个会话的改动落在独立分支上，不碰你当前的检出。
- **把别的智能体当引擎用。** 智能体配置可以通过 ACP 或 Codex app-server 跑在 Claude Code、Codex、Cursor、Gemini CLI、Kimi CLI、OpenCode 或 Grok Build 上。设置 → 外部引擎会检查每个引擎是否已安装，并列出还差哪些配置步骤。

![同一个会话里用了好几种模型：派发树中每个角色绑定不同的模型。](marketing/shots/r05-multi-model-fleet.zh.light.png)

## 长时间的活

- **它忙的时候你照样能说话。** 你发的消息先进队列，每条可以单独选什么时候发出：空闲后、子智能体完成后，或任务完成后；还能调顺序、改内容，或者立刻发出。
- **目标。** 消息以 `/goal` 开头会生成一张目标卡片，智能体跨多轮持续推进，可以编辑、暂停和取消。
- **定时提示词。** 智能体可以安排一次性或按 cron 表达式重复的提示词。全局面板列出所有定时任务，会话没打开也照常执行。
- **每个工作区一块任务看板。** 需求以卡片形式存在，关联到正在处理它的会话，智能体自己能读能改。
- **上下文撑得住。** 自动压缩可以按模型、按智能体设置，智能体的工作笔记在压缩后保留，长会话还可以换成「新窗口」上下文策略。

## 找回之前的内容

- **给智能体用的会话历史。** `HistorySearch`、`HistoryRead` 和 `HistoryList` 让智能体搜索之前的消息和工具输出、读取某一轮或某一步的原文、浏览会话的轮次目录，压缩前的内容也在范围内。默认只查当前会话、当前智能体，需要时可以扩大到整个工作区。
- **记忆。** 记忆默认开启。智能体用 `MemoryWrite` 把用户偏好、反馈、已核实的项目事实和参考指引存进全局或工作区记忆，再用 `MemorySearch`、`MemoryRead` 找回来。搜索支持部分词命中，也支持不加空格的中文短语。在设置 → 记忆里可以查看条目、要求写入前审批，或为某个工作区关闭记忆。

  主智能体的 `TodoList` 笔记可以在 `directives` 和 `decided` 中用 `[m_id]` 引用记忆。压缩时，交接文本会带上当前标题、跟随替代条目，并把已归档条目标为已撤回。解析这些引用不会改写保存的笔记或冻结的系统提示词。

- **侧栏搜索。** 会话标题始终可搜。对话内容的全文搜索在 CLI 服务端可用；打包的桌面应用里它是实验性选项（设置 → 搜索与检索），因为首次建索引可能要 20–30 分钟，且至少需要 2 GB 可用磁盘空间。
- **联网搜索与抓取。** 搜索和网页抓取走可查看的具名通道。GitHub 仓库搜索不需要密钥；同一供应商配了多个密钥时会在调用之间轮换。

## 桌面应用

- **时间线不会越拉越乱。** 做完的一段工具调用、思考和 shell 输出折叠成一行，比如「Worked · 8 steps」。进行中的这一轮和已结束的子智能体也这样折叠，图片结果单独占一行，每个折叠都能按原顺序展开。
- **右栏跟着当前智能体。** 它显示待处理的审批和问题、智能体此刻在做什么、上下文和花费、待办清单与工作笔记、智能体团队和后台任务。进入子智能体时，同一个右栏跟着过去。
- **输入框直接处理决定。** 有审批或问题等你时，它会接管输入框卡片，处理完你的草稿原样回来。批注、目标和队列都收在同一张卡片里，回车键的行为可以自己设。
- **临时对话。** 从 `/new`、侧栏或会话顶栏开启（终端里用 `kiki --ephemeral`）。临时对话不进历史、搜索和记忆，结束即删除。
- **以输入框为中心的新会话页。** 选好工作区、worktree 和智能体就可以打字，第一条消息发出后平滑过渡到会话视图。
- **找得到东西的设置。** 从「通用」到「实验室」约二十个页面，支持搜索。模型选单会标出每个模型的上下文大小和自动压缩点，并标记不支持图片输入的模型。
- **外观。** 内置多套皮肤，支持图片和视频背景，以及把配色和背景素材打包在一起的外观包。

## 插件与集成

- **插件。** 插件可以添加技能、智能体、MCP 服务器、hooks、命令、工具和沙箱面板。在「能力」页浏览、安装和配置插件。带 `.claude-plugin/plugin.json` 清单的 Claude Code 插件也能安装。官方市场里有 Kiki Office Suite（通过 OfficeCLI 处理 Word、Excel 和 PowerPoint）和 Kiki Writing。
- **通过 ACP 接入 IDE。** `kiki acp` 让 Zed、JetBrains 等 [ACP](https://agentclientprotocol.com/) 客户端驱动 Kiki 会话，见 [ACP 指南](https://x-t-e-r.github.io/kiki/zh/server/acp)。
- **数据留在本地。** 会话都存在你的机器上，不经过云端中转。

![提示词字段覆写，实时预览模型会看到的内容。](marketing/shots/d02-prompt-fields.zh.light.png)

**[查看全部功能 →](marketing/features.zh-CN.md)**

## 文档

[首次启动](https://x-t-e-r.github.io/kiki/zh/getting-started/first-launch) · [桌面应用](https://x-t-e-r.github.io/kiki/zh/getting-started/desktop-app) · [Agent Profiles](https://x-t-e-r.github.io/kiki/zh/customization/agent-profiles) · [提示词字段覆写](https://x-t-e-r.github.io/kiki/zh/customization/prompt-fields) · [插件](https://x-t-e-r.github.io/kiki/zh/customization/plugins) · [交互与审批](https://x-t-e-r.github.io/kiki/zh/guides/interaction) · [配置](https://x-t-e-r.github.io/kiki/zh/configuration/config-files) · [命令参考](https://x-t-e-r.github.io/kiki/zh/reference/command) · [工具参考](https://x-t-e-r.github.io/kiki/zh/reference/tools)

## 开发

环境要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/X-T-E-R/kiki.git && cd kiki && pnpm install
pnpm dev:cli    # 以开发模式运行 CLI
pnpm test       # 测试  ·  pnpm typecheck  ·  pnpm lint  ·  pnpm build
```

完整贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。问题请提到 [Issues](https://github.com/X-T-E-R/kiki/issues)；安全漏洞请参见 [SECURITY.md](SECURITY.md)。

## 致谢

Kiki 最初是 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork，现已独立发展；TUI 构建于 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上；桌面应用还改编了其他几个开源项目的代码和交互方式。每个项目 Kiki 用了什么、采用什么许可证，见 [ACKNOWLEDGEMENTS.zh-CN.md](ACKNOWLEDGEMENTS.zh-CN.md)。

## 许可证

基于 [MIT 许可证](LICENSE)发布。
