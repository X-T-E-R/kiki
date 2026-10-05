# Kiki 桌面版

Windows 版带签名应用内更新器，macOS 和 Linux 版没有：更新它们需要自己下载新版构建。本页说明两种更新方式、更新期间数据会怎样，以及如何回滚。安装步骤见[安装](./installation.md#安装桌面版)。

| 平台 | 安装包 | 更新方式 |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe`（当前用户安装，内含 CLI） | 应用内更新器，或运行新版安装包 |
| Linux x64 | `Kiki_*_amd64.deb` / `Kiki_*_amd64.AppImage` | 下载并安装新版构建 |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | 下载新版 dmg |
| macOS Intel | `Kiki_*_x64.dmg` | 下载新版 dmg |

各版本的 Windows 安装程序、更新签名、SHA256 校验和与更新清单都会保留在 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 中。

::: warning 注意
Windows 安装包没有 Authenticode 签名（Windows 的官方代码签名机制，签名后系统才会显示经过验证的发布者名称）。因此即使文件来自官方 Release，SmartScreen 仍可能显示「未知发布者」。见[SmartScreen 与更新签名](#smartscreen-与更新签名)。
:::

## 系统要求与发布通道

Windows 版为当前 Windows 账户安装，无需管理员权限。若系统缺少所需运行时，安装程序会下载 Microsoft Edge WebView2 引导程序（桌面界面渲染所用的微软网页组件）。

macOS 需要 **13.5 或更高版本**，这是应用内置运行时的下限。Intel 与 Apple Silicon 分开下载，不是同一个通用应用。Linux 桌面版为 x64（deb 或 AppImage），CLI/TUI 另外提供 arm64。Kiki 并不要求桌面环境，CLI/TUI 在没有显示器的机器上也能使用。

| 通道 | 提供什么 | 更新 feed |
| --- | --- | --- |
| Stable | 当前的稳定版构建 | `https://x-t-e-r.github.io/kiki/updater/stable/latest.json` |
| Beta | 已经过测试、但尚未转正的较新构建 | `https://x-t-e-r.github.io/kiki/updater/beta/latest.json` |

每个 feed 都是更新器读取的 JSON 文件，你不需要手动打开。Stable feed 指向已发布的最高 stable 版本，在首个 stable 发布前内容为空。只有 beta 构建的阶段，beta feed 才有内容；两者都存在之后，beta feed 按 SemVer（语义化版本号的比较规则，即比较主版本、次版本与修订号）指向其中更高的那个，所以选了 Beta 也可能拿到的就是当前稳定版。

## 安装与校验

请从版本化 Release 下载，不要用「latest 下载链接」，这样安装程序、校验和和更新元数据都来自同一个 `kiki-v<version>` tag。

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择你要的 stable 或 beta 版本。
2. 下载 `Kiki_*_x64-setup.exe` 安装程序和旁边的 `.sha256` 文件。
3. 在下载目录中打开 PowerShell，把下面的文件名换成你实际下载的文件名，运行这两条命令：第一条显示官方发布的校验和，第二条计算你手上文件的校验和。

   ```powershell
   Get-Content .\Kiki_1.0.0_x64-setup.exe.sha256
   (Get-FileHash .\Kiki_1.0.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
   ```

4. 确认两串十六进制字符完全相同。
5. 运行安装程序，然后从 Windows 开始菜单启动 Kiki。

`.sig` asset 是 Tauri 更新签名（Tauri 是桌面版使用的应用框架），供应用内更新器校验。手动安装时不需要它——上面的 `.sha256` 就是手动校验用的文件。

## 更新

更新相关的设置都在 **设置 → 关于**：这里显示当前版本，可以选择**更新通道**（Stable 或 Beta），并开关自动检查。打开自动检查后，Kiki 每天会找一次新版本；开关下面的**发现新版本时**决定那时怎么做——**通知我**弹出更新对话框，**下载并安装**则直接进入安装流程。两种模式都会在关闭有运行中任务的空间之前先问你。**检查更新**始终按你当前选的通道检查，无论自动检查开不开。

**通知我**模式下，对话框会显示版本号和一小段变更摘要，然后停下来等你。三个按钮并不是同一种决定：

- **明天再提醒我**——同一个版本 24 小时后再问一次。
- **跳过此版本**——Kiki 不再就这个通道上的这个版本问你，并且记住了。更新的版本仍会提示，在 Stable 上跳过也不会让 Beta 安静下来。
- **立即更新**——装上它。

用窗口按钮或 `Esc` 关掉对话框只关掉这一次提醒，什么都不记，之后仍可能再提示同一个版本。

安装之前，Kiki 会在你选的通道上重新查一次版本。通道或版本在这期间变过，它就刷新出新的一份，而不是装上与你同意的不一样的那个。如果还有某个空间存在运行中的会话或等待处理的输入，Kiki 会把这些空间列出来，请你确认后才关闭任何东西；拒绝确认，你的会话照常运行。确认之后，Kiki 关掉它所管理的后端，再下载和安装。切换通道不会把已安装的版本降级。

下载或安装这一步失败时，Kiki 会说明情况，安装按钮变成再试一次。你的会话要不要重新启动，取决于它走到了哪一步：更新界面还能用就直接重试，只有需要把那些会话恢复回来时才重启 Kiki。如果自动检查开关或通道选择没能保存，对话框会留在原地并提示再试一次。

如果应用内更新一直失败，请关闭 Kiki，从你要更新的那个 Release 准确下载新版安装程序，校验它的 `.sha256` 文件后手动运行。覆盖安装到现有的当前用户安装位置时，应用数据位置保持不变。

macOS 与 Linux 上请先退出 Kiki，把新版构建装到旧版本之上，再重新启动。如果还有旧 Kiki 进程在使用同一个数据家目录，请先退出它——见 [`KIKI_HOME`](../configuration/env-vars.md#kiki-home)。

## 后端日志

桌面版启动自己的后端时，后端的错误输出会写入当前空间 `logs` 目录中的 `desktop-backend.log`，与服务端自己的 `kimi-code.log` 并列。该文件达到 5 MiB 时轮转，保留三个编号备份，`.1` 是最新的一个。

后端默认以 `warn` 级别记录。要更改，退出桌面版，在当前空间的 `desktop.json` 里设置 `"logLevel"`，保留其他字段不变。可选值为 `fatal`、`error`、`warn`、`info`、`debug`、`trace` 和 `silent`。没有自己 `desktop.json` 的空间沿用主 home 的设置。新级别在桌面版下次启动后端时生效。

## SmartScreen 与更新签名

出现 SmartScreen 时，先核对 URL 和哈希再继续：URL 应位于 `github.com/X-T-E-R/kiki/releases/` 下，SHA256 应与官方发布的值一致。两项都对得上，再选择 **更多信息** 和 **仍要运行**。通过聊天、邮件或第三方镜像收到的副本必然过不了这一关，不要安装。

## 窗口、托盘与打开文件

Windows 和 macOS 上关窗会隐藏到托盘，真正退出请用托盘菜单的**退出**。Linux 上有可用托盘时，关窗改为最小化，方便窗口管理器把窗口调回；没有托盘时，关窗会请你确认退出。

从文件菜单打开文件，会交给系统中与该文件类型关联的程序。macOS 的 `.app` 与 `.command`、Linux 的 `.desktop`、Windows 的可执行文件与脚本不会打开——直接启动这些文件等于在应用之外运行代码。指向这些类型的快捷链接同样被拒绝。其他文件（包括普通文本文件）正常打开，**在文件管理器中显示** 也不受影响。

## 回滚

要退回上一个版本：先备份重要的数据、关闭 Kiki，然后从准确的 tag 下载旧版安装程序和它的 `.sha256` 文件，校验哈希后运行该安装程序。

如果 Windows 拒绝在较新版本上安装旧版，请先在 **已安装的应用** 中卸载 Kiki，再运行旧版安装程序。卸载时保留 Kiki 的应用数据，除非你确实想重置本地设置和会话。回滚后请留在 stable 通道，否则下次检查更新又会提示你安装 beta。
