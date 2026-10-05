# 安装

Kiki 有三种形态：支持 Windows、Linux 和 macOS 的 **Kiki 桌面版**、面向终端的 **CLI/TUI**（TUI 即终端里的文字交互界面），以及面向浏览器与 API 客户端的本地**服务器**。三种形态共享同一个 daemon（Kiki 在后台持续运行的常驻进程，因此各端看到的是同一份会话数据）和同一份会话存储，你可以在终端里开始一个任务，再在桌面版里接着看。

本页介绍如何安装与更新各形态。安装完成后请看[首次启动](./first-launch.md)。

::: tip 安装之前
Kiki 的终端形态在任何现代终端里都能正常运行，Windows Terminal、系统自带终端等无需任何调整。

支持真彩色和字体连字的终端渲染效果更细腻，[Kitty](https://sw.kovidgoyal.net/kitty/) 和 [Ghostty](https://ghostty.org/) 都是不错的选择。不换终端也不影响使用。
:::

## 安装桌面版

桌面版内含 Kiki 服务器和 CLI/TUI。Windows 安装包和 Linux deb 会让新终端能运行 `kiki`；AppImage 与 dmg 不会修改终端 `PATH`（系统查找可执行文件的目录列表）。

| 平台 | 桌面构建 | 安装后 `kiki` 命令是否可用 |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` | 是，新开终端后可用 |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | deb：是，但不会覆盖已有的 `/usr/local/bin/kiki`；AppImage：否 |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | 否，需手动链接内置 CLI |
| macOS Intel | `Kiki_*_x64.dmg` | 否，需手动链接内置 CLI |

macOS 需要 **13.5 或更高版本**；这个下限来自内置运行时，因此无论用哪种方式安装都适用。Intel 与 Apple Silicon 是分开下载的，按你的 Mac 选对应的一个。Linux 桌面构建只有 x64（deb 或 AppImage）；Linux 的 CLI/TUI 另外提供 arm64。

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择所需的 stable 或 beta 版 `kiki-v<version>` 标签。
2. 下载对应桌面构建和同名的 `.sha256` 文件，比较发布哈希与下载文件的哈希。macOS 用 `shasum -a 256 <文件>`，Linux 用 `sha256sum <文件>`，Windows PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256`。
3. Windows 运行安装包；Linux deb 运行 `sudo apt install ./Kiki_*.deb`；Linux AppImage 先运行 `chmod +x Kiki_*.AppImage`，再运行 `./Kiki_*.AppImage`；macOS 挂载 dmg 并把 Kiki 拖入「应用程序」。

macOS dmg **未经 Apple 签名或公证**。校验哈希后，首次启动时在「应用程序」里按住 Control 键点按 Kiki，选择 **打开** 并确认；若系统仍然阻拦，可运行 `xattr -dr com.apple.quarantine /Applications/Kiki.app` 清除这份应用的隔离标记。

dmg 不会把 `kiki` 命令加入 `PATH`。若要在终端使用内置 CLI，先确认 `/usr/local/bin/kiki` 不存在，再依次运行：

```sh
sudo mkdir -p /usr/local/bin
sudo ln -s /Applications/Kiki.app/Contents/MacOS/kiki-server /usr/local/bin/kiki
```

Windows 的 SmartScreen 提示与更新细节见 [Kiki 桌面版](./desktop-app.md)。

## 安装 CLI

只需终端时，在 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 的 `kiki-v<version>` 版本中按平台下载独立可执行文件。Windows 不单独分发 CLI 文件，Windows 上的 `kiki` 由桌面安装包提供。

| 平台 | 独立文件 |
| --- | --- |
| Linux x64 / ARM64 | `kiki-linux-x64` / `kiki-linux-arm64` |
| macOS Intel / Apple Silicon | `kiki-darwin-x64` / `kiki-darwin-arm64` |

把可执行文件和同名的 `<文件名>.sha256` 一起下载并比较哈希，然后改名为 `kiki`，执行 `chmod +x kiki`，放到 `PATH` 下的任意目录即可。独立可执行文件不需要 Node.js。桌面版安装之后，`kiki desktop` 会直接打开它；未安装时则会打印下载链接。

有 Node.js 24.15.0 或更新版本时，也可以从 npm 安装：

```sh
npm install -g kiki-agent       # CLI/TUI + 对应平台的桌面版
npm install -g kiki-agent-lite  # 仅 CLI/TUI
kiki --version
```

两个包只选一个安装，它们提供的是同一个 `kiki` 命令。`kiki-agent` 会在安装时下载并校验对应平台的桌面构建，因此需要联网，覆盖 Windows 与 Linux x64 以及 macOS Intel 和 Apple Silicon；`kiki-agent-lite` 只包含 CLI。

Windows 上两个包都依赖 [Git for Windows](https://gitforwindows.org/) 提供的 shell，请在首次运行前装好。Git Bash 装在非默认位置时，把 `KIKI_SHELL_PATH` 设置为 `bash.exe` 的绝对路径。

### 从源码开发

需要 Node.js `24.15.0` 或更高版本和 pnpm `10.33.0`。仓库是 pnpm（Node.js 的包管理器）工作区，在仓库根目录执行：

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

`dev:cli` 会启动本地开发构建，并把 `--help` 转发给 CLI 入口，不需要发布任何包或做全局安装。

## 更新与卸载

发行构建在升级前先确认当前版本：

```sh
kiki --version
```

**更新**：独立 CLI 用新版 Release 文件替换；npm 安装则运行 `npm install -g kiki-agent@latest` 或 `npm install -g kiki-agent-lite@latest`。Windows 桌面版还可以在 **设置 → 关于** 中检查并安装已签名的 NSIS 更新，见 [Kiki 桌面版](./desktop-app.md#更新)。Linux 和 macOS 桌面版没有应用内更新器，需要自己下载新版构建。

**卸载**：独立 CLI 从 `PATH` 中删除；npm 包运行 `npm uninstall -g kiki-agent` 或 `npm uninstall -g kiki-agent-lite`。这两条只卸载 CLI，桌面应用请通过系统卸载：Windows 在「已安装的应用」中操作，Linux deb 用系统包管理器，macOS 把「应用程序」里的 Kiki.app 拖到废纸篓。源码开发直接删除仓库检出即可。

以上操作都不会动你的数据。会话历史与配置位于 `~/.kiki/`，重装后依然可用；[数据路径](../configuration/data-locations.md)说明了如何一并清理。

## 下一步

- [首次启动](./first-launch.md) —— 启动 daemon 支持的界面、登录并完成第一次对话
- [Kiki 桌面版](./desktop-app.md) —— 桌面版安装通道、更新、回滚与 SmartScreen 细节
