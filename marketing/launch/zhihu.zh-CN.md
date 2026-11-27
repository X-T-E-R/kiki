# 知乎长文草稿（0.7.0）

**标题：** 一个任务里同时用几家模型，再把电脑、手机和真机连成一个工作台是什么体验

备选：
- 一件事，几家模型分工做：我做了一个本地多模型与跨设备智能体工作台
- 把 DeepSeek、Gemini 和强模型编进同一个会话，再用自建加密中转从手机指挥家里电脑

**话题：** 人工智能、大语言模型、程序员、开源项目、DeepSeek

---

先交代背景：Kiki 是一个开源的本地智能体工作台（MIT，https://github.com/X-T-E-R/kiki），作为本机服务运行，Electron 桌面应用、终端（`kiki`）、浏览器（`kiki web`）和双模式安卓客户端看到的是同一场工作。这篇不堆功能清单，讲我为什么这样拆多模型分工、怎么把跨设备和真机控制接进同一个本地工作台，以及现在还有哪些不完善的地方。

## 一、为什么不用一个模型干到底

长任务里，大部分 token 花在读文件、搜代码和范围清楚的局部改动上。这些活强模型能干，但没必要。更顺手的做法是：强模型负责想清楚意图和最后验收，日常步骤交给便宜模型，审查换另一家厂商，避免自己审自己共享同一批盲区。

## 二、一个任务里的分工与模型专武（Recipe）

在 Kiki 里，每个智能体就是一份 Markdown 文件：frontmatter 写工具、`model_alias`、思考档位和能派发谁，正文是系统提示词。保存后，下一次派发的子智能体立刻生效；已经在跑的会话保留启动快照，点「重建上下文」才切换。子智能体没绑模型也没配默认模型时会直接报 `model.not_configured`，不会悄悄回退去烧主会话的贵模型。

| 角色 | 模型 | 干什么 |
| --- | --- | --- |
| 主会话 | 强推理模型 | 拆任务、派活、验收 |
| 实现 | DeepSeek / 快模型 | 范围清楚的改动、跑检查 |
| 探查 | 便宜快模型 | 只读：搜代码、读文档、回事实 |
| 审查 | 另一家厂商 | 只读，独立核查边界与缺陷 |

Claude Code 是照着 Claude 调的，Codex 是照着 GPT 调的；Kiki 用配方（Recipe）给接进来的每个原生模型单独调——把提示词、模型设置和可选脚本 Hook 打包在一起，安装一次绑在模型上。公开仓库 https://github.com/X-T-E-R/kiki-recipes （MIT）发布了五套配方（GPT-6.1 Sol、GPT-6 Astra、DeepSeek V4.1、Gemini 4 Argon、Gemini 3.8 Flash），比如让 DeepSeek V4.1 动手前先推演机理与反例，让高频小模型先锚定一份样板。如果只想改某一条具体工具描述，也可以按模型覆写后用 `kiki prompt-fields explain <字段> --model <别名>` 核对完整来源链。

（配图：`docs/public/shots/workbench/workbench-per-role-models.zh.png`，标注「示例画面」）

## 三、把手机、家里电脑、测试真机与虚拟机接成一条线

0.7 版本我把「离开电脑以后怎么继续干活」和「智能体怎么碰真实界面」这两件事补齐了，核心约束是不把会话交给第三方托管云中转：

1. **双模式安卓客户端：** 安装官方签名 APK（`Kiki_*_android-release.apk`）后，首次打开二选一——选「连接电脑 Kiki」就是轻量远端壳，经局域网或自建 `kiki-relay` 直连家里电脑，不拉起本地进程；选「在本机运行 Kiki」则解压内置 Bionic Node 直接在手机上独立跑。应用内更新会核验字节长度、SHA-256 与签名证书。
2. **自建零知识加密中转（`kiki-relay`）：** 家里电脑在 NAT 后没有公网 IP 时，可以用 Node.js 24+ 或 Docker 跑一个轻量反向连接池服务。内层通信保持端到端 TLS 1.3 并固定目标空间的 P-256 SPKI 指纹，中转节点既不终止内层 TLS，也看不到凭据或对话内容。
3. **真机、本机桌面与远程虚拟机插件：** 官方插件目录（https://github.com/X-T-E-R/kiki-plugins ，20 个官方包）提供 `kiki-phone`（Mobilewright / Mobile MCP 控实体安卓与 iOS）、`kiki-cua`（本机多屏高分桌面控制）和 `kiki-uu-remote`（网易 UU 远程、Proxmox VE 虚拟机 RFB 3.8 直连与 VNC 桌面）。所有画面都回传工作台实时预览，且默认带一键人工接管防抢锁，人一接管立即中止代理动作。

（配图：`docs/public/shots/freedom/d02-prompt-fields.zh.png`，标注「示例画面」）

## 四、长线任务与非代码工作

1. **后台执行与按条排队：** 耗时的子智能体和命令丢到后台跑完自动通知主会话，不用轮询；它忙的时候发出去的消息进队列，每条可以选「空闲后 / 子代理完成后 / 任务完成后」送达。
2. **跨会话能力：** `/goal` 挂住跨轮次目标，分层记忆可逐条撤销，可选插件 `kiki-task-board` 维护需求卡片，历史对话支持从 Claude Code / Codex / OpenCode 导入。
3. **文档与媒体：** 需要拆本地 PDF/Office 装 `kiki-extract`（需 Python + MarkItDown），直接读写 Word/Excel/PPT 装 `kiki-office`，核对 CSV 装 `kiki-work`，生成图像/视频/语音/3D 装 `kiki-media`。

## 五、现在还不好的地方

- 仍在 `0.x`（当前公开版 `0.6.2`，`0.7.0` 候选发布中），细节上还有毛刺。
- macOS `.dmg` 未签名、未公证，首次打开需要按住 Control 点按打开。
- 0.7 的 Windows 桌面安装包已内置自包含 Git Bash 与 `rg`，但如果你在 Windows 上只通过 npm 装 CLI，仍需先装 Git for Windows；npm 安装需要 Node.js 24.22.1+ 或 26.12.1+（Linux / macOS 也可以用 `install.sh` 直接装免 Node 独立二进制）。
- 我没有做过任何模型跑分，上面的分工只是日常习惯，不代表某套组合绝对更好。项目最初 fork 自 Kimi Code，现在独立开发；TUI 基于 `pi-tui`。

## 六、想试的话

桌面安装包（Windows / macOS / Linux）和安卓 APK 直接在 GitHub Releases 下载：https://github.com/X-T-E-R/kiki/releases

终端安装：

```sh
# Linux / macOS 独立二进制（无需 Node.js）
curl -fsSL https://github.com/X-T-E-R/kiki/releases/latest/download/install.sh | sh

# 或通过 npm（Node.js 24.22.1+ 或 26.12.1+）
npm i -g kiki-agent
kiki
```

文档：https://x-t-e-r.github.io/kiki/zh/

欢迎在评论区聊聊你的多模型分工、自建加密中转习惯，或者最想单独调教哪个模型的工具描述。
