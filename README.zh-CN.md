# Kiki

**Agents as profiles. Fleets under your control.**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/zh/) <br>
[文档](https://x-t-e-r.github.io/kiki/zh/) · [问题反馈](https://github.com/X-T-E-R/kiki/issues) · [English](README.md)

Kiki 是一个本地 agent 工作台：每一个 agent——无论是主 agent 还是子代理——都是一份你拥有的 Markdown 文件。Kiki 让它们跑起来、编成队，并在整个过程中保持机队可见。它以三种形态提供——桌面应用、终端 CLI/TUI、浏览器 UI——共享同一个守护进程和同一份会话数据。Kimi 模型开箱即用，也可以配置其他兼容供应商。

无云端中转，无 agent 锁定，无黑盒提示词。

Kiki 最初是 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork，现已独立发展。

## 为什么是 Kiki

**拥有你的 agent。** 一个 Kiki agent 就是一份 Markdown 文件：frontmatter 声明它的工具、模型绑定与派发规则，正文*就是*它的系统提示词。profile 约 200ms 热更新，可以在设置界面或任何编辑器里修改，并且可移植——你现有的 Claude Code、OpenCode agent 文件可以直接加载。所有内置提示词都可覆写，精确到单个工具的描述：全局、按模型、按 profile 三层任选，配合 `kiki prompt-fields` 可以查证模型最终看到的每一段文字。

**指挥你的机队。** 把子代理派进隔离上下文，每个角色可绑定各自模型；耗时任务转后台；agent 忙碌时消息排队、逐条调整时机；`/goal` 锁定一个跨轮持续推进的目标；cron 按计划往会话里注入 prompt；任务看板按工作区跟踪进展。

**真正的 agent 工具链。** agent 操作的是和你同一套台面：`AgentRun` / `AgentSend` / `AgentList` 派发和联络子代理，`ThreadCreate` 直接开一条带独立工作区的全新会话线程，`CronCreate` 安排未来工作，`CreateGoal` 锁定长期目标，`TaskList` / `TaskOutput` / `TaskStop` 监督正在运行的一切。编排是 agent 自己动手做的事，不是要你接线的工程。

**看见一切。** agent 面板实时展示派发树——谁在跑、谁完成了、带回了什么；会话时间线把工具步骤折叠成组，不占你的注意力。完成通知、提问、审批都是一等公民的界面，不是需要你去翻的日志。

## 功能一览

- **三种形态，一个工作台。** 桌面应用、终端 TUI 与浏览器 UI 共享同一个守护进程、会话与配置，随时切换；也可以通过 [ACP](https://agentclientprotocol.com/) 从 Zed、JetBrains 直接驱动会话。
- **视频也能输入。** 把屏幕录像、演示视频拖进对话，让 agent 看那些难以用文字描述的东西。
- **AI 原生 MCP 配置。** 用 `/kiki-ops` 以对话方式添加、编辑、认证 MCP 服务器，无需手改 JSON。
- **插件生态。** 从市场或任意 GitHub 仓库安装 skill、MCP 服务器与数据源，每次安装都会明示信任级别。
- **生命周期 hooks。** 在关键节点执行本地命令：拦截高风险工具调用、审计决策、触发桌面通知，或对接你自己的自动化脚本。
- **供应商与模型管理。** 在设置界面配置供应商、模型与思考强度；凭证保存在可检查的本地文件中。

## 安装

从 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 下载对应构建：

- **桌面应用（推荐）**：Windows 安装包 `Kiki_*_x64-setup.exe`。
- **CLI**：在 `kiki-v<版本号>` 的 Release 资产中选择对应平台的 `kiki` 可执行文件。

> 在 Windows 上，首次启动前请先安装 [Git for Windows](https://gitforwindows.org/)，因为 Kiki CLI 使用自带的 Git Bash 作为 shell 环境。如果 Git Bash 安装在自定义位置，请将 `KIKI_SHELL_PATH` 设置为 `bash.exe` 的绝对路径。

然后在一个新的终端会话中验证：

```sh
kiki --version
```

CLI 未发布到 npm；请使用 Release 产物，或在开发时从源码运行。更新渠道等细节见[安装](https://x-t-e-r.github.io/kiki/zh/getting-started/installation)。

## 快速上手

进入项目目录并启动交互界面：

```sh
cd your-project
kiki        # 终端界面
kiki web    # 浏览器界面
```

首次启动后，运行 `/login`，选择 Kimi Code OAuth 或 Moonshot AI 开放平台的 API 密钥。登录后试试第一个任务：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

## 在编辑器中使用（ACP）

Kiki 支持 [Agent Client Protocol](https://agentclientprotocol.com/)，ACP 兼容的编辑器与 IDE（Zed、JetBrains 等）可以通过 stdio 驱动会话。只需登录一次，然后把编辑器指向 `kiki acp` 子命令，无需重复登录。

以 Zed 为例，在 `~/.config/zed/settings.json` 中加入：

```json
{
  "agent_servers": {
    "Kiki": {
      "type": "custom",
      "command": "kiki",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

然后在 Zed 的 Agent 面板中新建对话。JetBrains 的配置与故障排查见 [ACP 指南](https://x-t-e-r.github.io/kiki/zh/server/acp)。

## 文档

- [安装](https://x-t-e-r.github.io/kiki/zh/getting-started/installation)
- [首次启动](https://x-t-e-r.github.io/kiki/zh/getting-started/first-launch)
- [桌面应用](https://x-t-e-r.github.io/kiki/zh/getting-started/desktop-app)
- [Agent Profiles](https://x-t-e-r.github.io/kiki/zh/customization/agent-profiles)
- [提示词字段覆写](https://x-t-e-r.github.io/kiki/zh/customization/prompt-fields)
- [交互与审批](https://x-t-e-r.github.io/kiki/zh/guides/interaction)
- [配置](https://x-t-e-r.github.io/kiki/zh/configuration/config-files)
- [命令参考](https://x-t-e-r.github.io/kiki/zh/reference/command)

## 开发

环境要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

```sh
git clone https://github.com/X-T-E-R/kiki.git
cd kiki
pnpm install
```

```sh
pnpm dev:cli    # 以开发模式运行 CLI
pnpm test       # 运行测试
pnpm typecheck  # TypeScript 检查
pnpm lint       # 运行 oxlint
pnpm build      # 构建全部包
```

完整的贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 社区

- [问题反馈](https://github.com/X-T-E-R/kiki/issues)
- 安全漏洞反馈请参见 [SECURITY.md](SECURITY.md)。

## 致谢

Kiki 的 TUI 构建于 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上，项目最初是 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork。感谢两个项目的作者们做出的宝贵工作。

## 许可证

基于 [MIT 许可证](LICENSE)发布。
