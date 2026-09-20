# Kiki

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/zh/) <br>
[文档](https://x-t-e-r.github.io/kiki/zh/) · [问题反馈](https://github.com/X-T-E-R/kiki/issues) · [English](README.md)

## Kiki 是什么

Kiki 是一个本地 agent 工作台：它能读写代码、执行 shell 命令、检索文件、抓取网页，并根据反馈自主决定下一步。它以三种形态提供——桌面应用、终端 CLI/TUI、本地服务器承载的浏览器 UI——三者共享同一个守护进程和同一份会话数据。Kiki 开箱即用地支持 Moonshot AI 的 Kimi 模型，也可以配置其他兼容供应商。

Kiki 最初是 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 fork，现已独立发展。

## 安装

从 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 下载对应构建：

- **桌面应用（推荐）**：Windows 安装包 `Kiki_*_x64-setup.exe`。
- **CLI**：在 `kiki-v<版本号>` 的 Release 资产中选择对应平台的 `kiki` 可执行文件。

> 在 Windows 上，首次启动前请先安装 [Git for Windows](https://gitforwindows.org/)，因为 Kiki CLI 使用自带的 Git Bash 作为 shell 环境。如果 Git Bash 安装在自定义位置，请将 `KIMI_SHELL_PATH` 设置为 `bash.exe` 的绝对路径。

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

## 核心特性

- **三种形态，一个工作台**。桌面应用、终端 TUI 与浏览器 UI 共享同一个守护进程、会话与配置，可随时切换。
- **子代理并行作业**。在隔离上下文中派发子代理处理子任务，主对话保持清爽，并可在 agent 面板实时观察。
- **后台任务与消息队列**。耗时工作可转为后台任务；agent 忙碌时发送的消息会排队，每条消息可单独调整开始时机。
- **目标模式**。以 `/goal` 开头的消息会锁定一个目标，agent 跨轮次持续推进，支持暂停、编辑与取消。
- **任务看板**。按工作区跟踪需求与任务，并关联到处理它们的会话。
- **定时任务**。cron 作业按计划把 prompt 注入会话，在全局面板统一管理。
- **供应商与模型管理**。在设置界面配置供应商、模型与思考强度；Kimi 开箱即用。
- **视频也能输入**。把屏幕录像、演示视频拖进对话，让 agent 看那些难以用文字描述的东西。
- **AI 原生 MCP 配置**。用 `/kiki-ops` 以对话方式添加、编辑、认证 MCP 服务器，无需手改 JSON。
- **丰富的插件生态**。从市场或任意 GitHub 仓库安装 skill、MCP 服务器与数据源，每次安装都会明示信任级别。
- **生命周期 hooks**。在关键节点执行本地命令：拦截高风险工具调用、审计决策、触发桌面通知，或对接你自己的自动化脚本。
- **编辑器与 IDE 集成（ACP）**。通过 `kiki acp`，从 Zed、JetBrains 或任何 [Agent Client Protocol](https://agentclientprotocol.com/) 客户端直接驱动 Kiki 会话。

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
