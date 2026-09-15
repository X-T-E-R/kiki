# 安装

Kiki 以三种形态发布，共享同一个 daemon 与同一份会话数据：Windows 平台的 **Kiki 桌面版**、面向终端的 **CLI/TUI**，以及面向浏览器与 API 客户端的本地**服务器**。本页介绍如何安装与更新各形态；安装后的第一步请见[首次启动](./first-launch.md)。

::: tip 安装之前
Kiki 是全交互式 TUI 应用，推荐在支持真彩色与连字的现代终端中运行以获得最佳体验，例如 [Kitty](https://sw.kovidgoyal.net/kitty/) 或 [Ghostty](https://ghostty.org/)。
:::

## 安装桌面版

桌面版是体验 Kiki 的推荐方式。它安装 Kiki 并运行内置服务器，让你无需接触终端即可通过图形界面工作。

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择所需的 stable 或 beta 版本。
2. 下载 `Kiki_*_x64-setup.exe` 安装程序和同名的 `.sha256` 文件。
3. 校验 SHA256 并运行安装程序——详细步骤、更新通道与 Windows SmartScreen 说明见 [Kiki 桌面版](./desktop-app.md)。

## 安装 CLI

CLI 通过 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 以版本化发行工件（`kiki-v<version>` 标签）发布，Kiki `0.1.0` 及之后版本均可在该页面获取。

::: warning Windows SmartScreen
发行二进制未做代码签名，因此即使文件来自官方 Release，Windows SmartScreen 也可能把发布者显示为未知。运行前请确认下载链接位于 `github.com/X-T-E-R/kiki/releases/` 之下。
:::

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择一个版本。
2. 从该版本的资产列表中下载对应平台的 CLI 工件。
3. 将 `kiki` 可执行文件放入 `PATH`，然后验证：

```sh
kiki --version
```

> 在 Windows 上，首次启动前请先安装 [Git for Windows](https://gitforwindows.org/)。Kiki 使用其自带的 Git Bash 作为 Shell 环境；如果 Git Bash 安装在自定义位置，请将 `KIMI_SHELL_PATH` 设为 `bash.exe` 的绝对路径。

CLI 未发布到 npm；请使用发行工件，或在开发时从源码运行。

### 从源码开发

源码开发需要 Node.js `24.15.0` 或更高版本以及 pnpm `10.33.0`。在仓库根目录执行：

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

根目录的 `dev:cli` 脚本运行 `apps/kimi-code` 的 `dev` 脚本。它会启动本地开发 marketplace 服务器，并把 `--help` 转发给 CLI 入口；无需已发布的包或全局安装。

## 更新与卸载

发行构建在升级前先确认当前版本：

```sh
kiki --version
```

**更新**：按对应 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 版本中的说明和工件名称操作，用新工件替换 `kiki` 可执行文件。桌面版也可以在 **Settings → About** 中检查并安装更新——见 [Kiki 桌面版](./desktop-app.md#update)。

**卸载**：从 `PATH` 中删除 `kiki` 可执行文件即可。源码开发通过删除仓库检出移除。桌面版在 Windows 设置的「已安装应用」中卸载。删除可执行文件不会删除你的数据——会话历史与配置位于 `~/.kiki/`，下次安装仍可使用；如需一并删除，见[数据路径](../configuration/data-locations.md)。

## 下一步

- [首次启动](./first-launch.md) —— 启动 daemon 支持的界面、登录并完成第一次对话
- [Kiki 桌面版](./desktop-app.md) —— 桌面版安装通道、更新、回滚与 SmartScreen 细节
