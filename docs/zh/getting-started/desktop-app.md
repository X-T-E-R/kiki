# Kiki 桌面版

Kiki 桌面版是 Kiki 的 Windows 桌面应用，通过 NSIS（一种常见的 Windows 安装程序格式）安装程序分发，只安装给当前 Windows 用户，支持 64 位 Windows。官方安装程序、更新签名、SHA256 校验和与版本化更新清单都会保留在 [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) 中。

::: warning 注意
首个公开版本的 Kiki Windows 安装程序没有 Authenticode 签名（Windows 用来验证发布者身份的官方代码签名）。因此，即使文件来自官方 Release，Windows SmartScreen 也可能把发布者显示为未知。
:::

## 系统要求与发布通道

桌面版支持 Windows x64，正常情况下可为当前 Windows 账户安装，无需管理员权限。如果系统缺少所需运行时，安装期间可能会下载 Microsoft Edge WebView2 引导程序（桌面界面依赖的微软网页组件）。

| 通道 | 适用场景 | 公开 feed（更新通道的元数据地址，非 RSS 订阅源） |
| --- | --- | --- |
| Stable | 普通日常使用 | `https://x-t-e-r.github.io/kiki/updater/stable/latest.json` |
| Beta | 提前使用经过测试的较新版本 | `https://x-t-e-r.github.io/kiki/updater/beta/latest.json` |

Stable feed 指向已发布的最高 stable 版本，在首个 stable 发布前暂不存在。公开 beta 阶段可直接使用 Beta feed；stable 发布后，Beta feed 再按 SemVer（Semantic Versioning，语义化版本号的比较规则，即比较主版本、次版本与修订号）比较最高 stable 与 beta 版本并指向其中较高者。

## 安装与校验

安装应从版本化 Release 开始，而不是使用未版本化的下载链接。这样可以保证安装程序、校验和与更新元数据都绑定到同一个 `kiki-v<version>` tag。

1. 打开 [Kiki Releases 页面](https://github.com/X-T-E-R/kiki/releases)，选择所需的 stable 或 beta 版本。
2. 下载 `Kiki_*_x64-setup.exe` 安装程序及旁边的 `.sha256` 文件。
3. 在下载目录中打开 PowerShell，粘贴运行以下命令，并把示例文件名替换为实际下载的安装程序（第一条命令显示官方发布的校验和，第二条命令计算你下载文件的校验和，两条输出一致即表示文件完整无损）：

   ```powershell
   Get-Content .\Kiki_1.0.0_x64-setup.exe.sha256
   (Get-FileHash .\Kiki_1.0.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
   ```

4. 确认两处十六进制哈希完全相同。
5. 运行安装程序，然后从 Windows 开始菜单启动 Kiki。

`.sig` asset 包含完整的 Tauri 更新签名（Tauri 是 Kiki 桌面版使用的应用框架，这里的签名供其内置更新器使用）；它与手动下载校验所用的 SHA256 校验和相互独立。

## 更新

Kiki 桌面版会在启动后按当前通道检查一次更新。你也可以在 **设置 → 关于** 中选择 Stable 或 Beta，并手动检查更新。发现新版本后，Kiki 会先显示版本号和发布说明，再请求安装确认。

确认安装后，Kiki 桌面进程和内置 sidecar（与桌面界面一同运行的后台服务进程）会退出，随后校验已签名的安装程序并运行 NSIS 更新。正在运行的任务会被中断，因此请先完成或停止重要任务。切换通道不会自动降级到旧版本。

如果应用内更新失败，请关闭 Kiki，从目标版本的准确 Release 下载较新的安装程序，校验其 SHA256 文件，然后手动运行安装程序。把较新版本安装到现有的当前用户安装位置时，正常的应用数据位置会保持不变。

公开 `latest.json` 文件为 stable 与 beta 客户端提供带签名的更新元数据。每份清单都指向特定 `kiki-v<version>` tag 下的安装程序，而不是可变的 latest 下载链接；其中的 `signature` 字段就是该安装程序 `.sig` asset 的内容。

## SmartScreen 与更新签名

SmartScreen 信誉与更新签名解决的是两个不同的问题：SmartScreen 关心的是「这个安装程序是谁发布的」，更新签名关心的是「这个文件是否被篡改过」。因为安装程序没有 Authenticode 签名，Windows 无法显示经过验证的发布者身份；而 Tauri `.sig` 更新签名则允许应用内更新器确认下载的安装程序由 Kiki 更新密钥签名。两条信息互补、并不冲突。

如果出现 SmartScreen，先确认 URL 位于 `github.com/X-T-E-R/kiki/releases/` 下，并确认 SHA256 值一致。只有完成这些检查并接受未知发布者风险后，才选择 **更多信息** 和 **仍要运行**。不要安装通过聊天、邮件或第三方镜像收到的副本。

## 回滚

回滚使用 Releases 页面上保留的不可变 asset。先备份重要的工作区数据并关闭 Kiki，再从准确 tag 下载上一个版本的安装程序和 `.sha256` 文件，校验哈希后运行该安装程序。

如果 Windows 拒绝在较新版本上安装旧版本，请在 **已安装的应用** 中卸载 Kiki，然后运行旧版安装程序。除非你还希望重置本地设置和会话，否则卸载时不要删除 Kiki 的应用数据。回滚后请使用 stable feed，或继续从 stable Release 手动更新，避免再次立即选择较新的 beta。
