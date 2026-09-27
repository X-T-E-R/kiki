# Kiki

**你的智能体，你说了算。**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/zh/) <br>
[文档](https://x-t-e-r.github.io/kiki/zh/) · [功能一览](marketing/features.zh-CN.md) · [截图巡览](marketing/gallery.zh-CN.md) · [问题反馈](https://github.com/X-T-E-R/kiki/issues) · [English](README.md)

Kiki 是一个开源的 AI 智能体工作台，跑在你自己的机器上：桌面应用、终端界面、浏览器界面，背后是同一个本地守护进程。

<!-- 主图：主会话调度多条线的真实录屏（见 marketing/launch/demo-storyboard.md）录好后替换。 -->
![Kiki 工作台：主会话和它派出的子智能体、一个后台任务、进行中的目标，以及一条排队消息。](marketing/shots/h01-fleet-workbench.zh.light.png)

*示例场景由真实 Kiki 界面渲染，不代表模型性能实测；之后会换成真实录屏。*

## 自由：每一层都归你

- **模型。** 每个角色单独绑模型，不同厂商混着用：海外前沿模型做规划，DeepSeek、GLM 跑日常的活，审查再换一家。Kimi 开箱即用，Anthropic、OpenAI 兼容、Gemini、Vertex 等都能接。
- **智能体。** 一个智能体就是一份你自己的 Markdown：frontmatter 写工具、模型和能派发谁，正文就是系统提示词。手里现成的 Claude Code、OpenCode agent 文件直接能用，改完约 200ms 生效。
- **提示词。** 内置提示词的任意字段都能改，细到单个工具的描述；可以全局改，也可以按模型、按智能体单独改。`kiki prompt-fields list | show | explain` 能看到模型最终收到了什么、每一段来自哪一层。
- **数据。** 会话都存在本地，不经过云端中转；项目以 MIT 许可证开源。

![提示词字段覆写，实时预览模型会看到的内容。](marketing/shots/d02-prompt-fields.zh.light.png)

## 强大：扛得住长时间、多条线并行的活

- **主智能体同时推进好几条线。** 它会自己派子智能体、把耗时的活转到后台；后台跑完会自动通知它，不用它反复去查。
- **它忙的时候你照样能说话。** 你发的消息先进队列，每条可以单独选什么时候发出：空闲后、子智能体完成后，或任务完成后；还能调顺序、改内容，或者直接插进当前这一轮。
- **活不会随会话结束而丢。** 按工作区划分的需求看板，智能体自己能读能写；`/goal` 目标跨多轮持续推进；cron 定时往会话里投任务。
- **一个守护进程，哪里都能接着干。** 桌面、终端、浏览器看的是同一批会话，Zed 和 JetBrains 可以通过 [ACP](https://agentclientprotocol.com/) 接入。

![同一个会话里用了好几种模型：派发树中每个角色绑定不同的模型。](marketing/shots/r05-multi-model-fleet.zh.light.png)

**[查看全部功能 →](marketing/features.zh-CN.md)**

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

新会话默认是「自动」模式：日常操作直接执行，碰到敏感文件或危险命令仍会先问你。用 `/permission` 切换模式。Windows 用户请先装好 Git for Windows（见下文）。

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

新开终端运行 `kiki --version` 验证。校验命令和更新通道见[安装](https://x-t-e-r.github.io/kiki/zh/getting-started/installation)；在 Zed / JetBrains 里使用见 [ACP 指南](https://x-t-e-r.github.io/kiki/zh/server/acp)。

## 文档

[首次启动](https://x-t-e-r.github.io/kiki/zh/getting-started/first-launch) · [桌面应用](https://x-t-e-r.github.io/kiki/zh/getting-started/desktop-app) · [Agent Profiles](https://x-t-e-r.github.io/kiki/zh/customization/agent-profiles) · [提示词字段覆写](https://x-t-e-r.github.io/kiki/zh/customization/prompt-fields) · [交互与审批](https://x-t-e-r.github.io/kiki/zh/guides/interaction) · [配置](https://x-t-e-r.github.io/kiki/zh/configuration/config-files) · [命令参考](https://x-t-e-r.github.io/kiki/zh/reference/command)

## 开发

环境要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/X-T-E-R/kiki.git && cd kiki && pnpm install
pnpm dev:cli    # 以开发模式运行 CLI
pnpm test       # 测试  ·  pnpm typecheck  ·  pnpm lint  ·  pnpm build
```

完整贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。问题请提到 [Issues](https://github.com/X-T-E-R/kiki/issues)；安全漏洞请参见 [SECURITY.md](SECURITY.md)。

## 致谢

Kiki 最初是 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork，现已独立发展；TUI 构建于 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上。感谢两个项目的作者们做出的宝贵工作。

## 许可证

基于 [MIT 许可证](LICENSE)发布。
