# 安装

Kiki 以三种形态发布，共享同一个 daemon（Kiki 在后台持续运行的常驻进程，各端通过它共享会话数据）：支持 Windows、Linux 和 macOS 的 **Kiki 桌面版**、面向终端的 **CLI/TUI**（TUI 即终端里的文字交互界面），以及面向浏览器与 API 客户端的本地**服务器**。本页介绍如何安装与更新各形态；安装后的第一步请见[首次启动](./first-launch.md)。

::: tip 安装之前
Kiki 的终端形态在任何现代终端里都能正常运行，Windows Terminal、系统自带终端等无需任何调整。

想要最佳的视觉体验（更细腻的字体渲染和图标显示），推荐使用支持真彩色与连字的现代终端，例如 [Kitty](https://sw.kovidgoyal.net/kitty/) 或 [Ghostty](https://ghostty.org/)。这是可选项，不装也完全不影响使用。
:::

## 安装桌面版

桌面版内含 Kiki 服务器和 CLI/TUI。Windows 安装包和 Linux deb 会让新终端能运行 `kiki`；AppImage 与 dmg 不会修改终端 `PATH`（系统查找可执行文件的目录列表）。

| 平台 | 桌面构建 | 安装后 `kiki` 命令是否可用 |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` | 是，新开终端后可用 |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | deb：是，但不会覆盖已有的 `/usr/local/bin/kiki`；AppImage：否 |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | 否，需手动链接内置 CLI |
| macOS Intel | `Kiki_*_x64.dmg` | 否，需手动链接内置 CLI |

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择所需的 stable 或 beta 版 `kiki-v<version>` 标签。
2. 下载对应桌面构建和同名的 `.sha256` 文件，比较发布哈希与下载文件的哈希。macOS 用 `shasum -a 256 <文件>`，Linux 用 `sha256sum <文件>`，Windows PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256`。
3. Windows 运行安装包；Linux deb 运行 `sudo apt install ./Kiki_*.deb`；Linux AppImage 先运行 `chmod +x Kiki_*.AppImage`，再运行 `./Kiki_*.AppImage`；macOS 挂载 dmg 并把 Kiki 拖入「应用程序」。

macOS dmg **未经 Apple 签名或公证**。校验后，首次启动时在「应用程序」里按住 Control 键点按 Kiki，选择 **打开** 并确认。若系统仍阻拦且你信任已校验的下载，可运行 `xattr -dr com.apple.quarantine /Applications/Kiki.app` 清除这份应用的隔离标记。需从终端使用内置 CLI 时，先确认 `/usr/local/bin/kiki` 不存在，再依次运行 `sudo mkdir -p /usr/local/bin` 和 `sudo ln -s /Applications/Kiki.app/Contents/MacOS/kiki-server /usr/local/bin/kiki`。Windows SmartScreen 提示与更新细节见 [Kiki 桌面版](./desktop-app.md)。

## 安装 CLI

若只需终端，请在 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 的 `kiki-v<version>` 版本中选择独立可执行文件。Windows 不再单独分发 CLI 文件，由桌面安装包提供 `kiki`。

| 平台 | 独立文件 |
| --- | --- |
| Linux x64 / ARM64 | `kiki-linux-x64` / `kiki-linux-arm64` |
| macOS Intel / Apple Silicon | `kiki-darwin-x64` / `kiki-darwin-arm64` |

下载对应的 `<文件名>.sha256` 并比较哈希。把文件改名为 `kiki`，执行 `chmod +x kiki`，再将其放入 `PATH`。独立 SEA 可执行文件无需 Node.js。`kiki desktop` 可打开已安装的桌面版，未安装则显示安装链接。

使用 Node.js 24.15.0 或更新版本时，也可选择以下 npm 安装方式：

```sh
npm install -g kiki-agent       # CLI/TUI + 对应平台的桌面版
npm install -g kiki-agent-lite  # 仅 CLI/TUI
kiki --version
```

两个 npm 包都提供 `kiki` 命令，同一环境中只选一个。完整版安装时会从 GitHub 下载并校验桌面构建，需要联网；支持 Windows/Linux x64 与 macOS Intel/Apple Silicon。lite 包不下载桌面构建。Windows 下两种方式都需要先安装 [Git for Windows](https://gitforwindows.org/)；若 Git Bash 安装在自定义位置，请把 `KIKI_SHELL_PATH` 设置为 `bash.exe` 的绝对路径。

### 从源码开发

Kiki 的源码仓库是一个 pnpm（Node.js 的包管理器）工作区，源码开发适合想参与开发或调试 CLI 本身的用户。需要 Node.js `24.15.0` 或更高版本以及 pnpm `10.33.0`。在仓库根目录执行：

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

根目录的 `dev:cli` 脚本会启动本地开发环境，并把 `--help` 转发给 CLI 入口；无需已发布的包或全局安装。

## 更新与卸载

发行构建在升级前先确认当前版本：

```sh
kiki --version
```

**更新**：独立 CLI 可用新版 Release 文件替换；npm 安装则运行 `npm install -g kiki-agent@latest` 或 `npm install -g kiki-agent-lite@latest`。Windows 桌面版可在 **设置 → 关于** 中检查并安装已签名的 NSIS 更新，见 [Kiki 桌面版](./desktop-app.md#更新)。Linux 和 macOS 的桌面构建需要手动下载新版，不使用 Windows 的更新 feed。

**卸载**：独立 CLI 从 `PATH` 删除；npm 包运行 `npm uninstall -g kiki-agent` 或 `npm uninstall -g kiki-agent-lite`。npm 卸载不会自动删除安装包安装的 Windows 应用或已复制到「应用程序」的 macOS 应用，仍需在系统中卸载。源码开发可删除仓库检出。Windows 桌面版在「已安装的应用」卸载，Linux deb 使用系统包管理器，macOS 删除「应用程序」里的 Kiki.app。删除可执行文件不会删除你的数据——会话历史与配置位于 `~/.kiki/`，下次安装仍可使用；如需一并删除，见[数据路径](../configuration/data-locations.md)。

## 下一步

- [首次启动](./first-launch.md) —— 启动 daemon 支持的界面、登录并完成第一次对话
- [Kiki 桌面版](./desktop-app.md) —— 桌面版安装通道、更新、回滚与 SmartScreen 细节
