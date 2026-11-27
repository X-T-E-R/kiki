# LinuxDo 草稿（0.7.0）

**分类：** 开发调优（或 资源荟萃，以版规为准）
**标签：** 开源、AI、DeepSeek、GLM、自托管

**标题：** 一个会话里混编几家模型 + 5G 手机自建 E2EE 中转直连家里电脑控真机：开源本地工作台 Kiki 0.7（MIT）

**正文：**

平时跑长任务有两个很具体的痛点：一是不想把探查、实现、审查全塞给同一个贵模型；二是出门在外想接着指挥家里电脑干活，甚至让它直接操作桌边的测试手机或内网 PVE 虚拟机，又不想把会话交给第三方托管云中转。

Kiki 是一个开源（MIT）的本地智能体工作台。Electron 桌面端、终端（`kiki`）、浏览器（`kiki web`）和安卓客户端共享同一个本机守护进程。这帖直接拆 0.7 里的几个核心机制，不讲空词。

## 1. 按角色绑模型，换一家厂商审 diff

每个智能体是一份纯文本 Markdown，frontmatter 里写 `model_alias`：

```markdown
---
name: implementer
description: 按明确的范围实现改动并跑检查
model_alias: deepseek
tools: [Read, Grep, Glob, Edit, Write, Bash]
---
你负责实现……
```

典型分工：

- 主会话（规划、拆活、验收）：强推理模型
- 实现与范围清楚的改动：DeepSeek 或快模型
- 只读探查：便宜快模型
- 审查：换另一家厂商，避免和实现共享盲区（一次独立审查往往几美分就能拦住边界漏项）

`model_alias` 对应 `config.toml` 里 `[models]` 的别名。子智能体**没有绑模型、也没有配 `[subagent].default_model` 时会直接报 `model.not_configured`**，不会悄悄继承主会话的贵模型。

## 2. 每个模型都有自己的专武（Recipe）+ 单条工具描述覆写

Claude Code 照着 Claude 调，Codex 照着 GPT 调；Kiki 用配方（Recipe）给接进来的每个原生模型单独调——把提示词、模型设置和可选脚本 Hook 打包在一起，安装一次绑在模型上。公开仓库 https://github.com/X-T-E-R/kiki-recipes （MIT）已有五套配方（GPT-6.1 Sol、GPT-6 Astra、DeepSeek V4.1、Gemini 4 Argon、Gemini 3.8 Flash），例如让 DeepSeek V4.1 动手前先推演机理与反例，让高频小模型先锚定样板再下笔。外部执行器跑的回合不套用 Recipe。

只想改某一条内置工具描述也可以按模型覆写，并用 `explain` 核对最终生效值与来源链：

```sh
kiki prompt-fields list
kiki prompt-fields explain tool.web-search.description --model deepseek
```

## 3. 跨设备双模式安卓 + 自建端到端加密中转（`kiki-relay`）

很多时候家里电脑在 NAT 后没有公网 IP，之前要么折腾穿透要么绑 IM。现在有两块拼齐了：

- **双模式安卓客户端（`Kiki_*_android-release.apk`）：** 首次打开直接二选一——选「连接电脑 Kiki」就是轻量远端壳，经局域网或 `kiki-relay` 连回家里电脑，不拉起本地进程；选「在本机运行 Kiki」则会解压内置 Bionic Node 直接在手机上独立运行。官方签名 APK 内置 SHA-256 与签名证书校验的自动更新。
- **自建零知识中转（`kiki-relay`）：** 一个单文件 Node.js 24+ / Docker 服务，跑在自己的小 VPS 上即可。采用预热反向 WebSocket 连接池实现 0ms 交接，**内层全程保持端到端 TLS 1.3 并固定到目标空间的 P-256 SPKI 指纹（`fp`）**，中转节点不终止内层 TLS、看不到会话内容或凭据。

## 4. 60fps 常驻真机 / 远控面板与 3GB+ 长会话底座

官方插件库（https://github.com/X-T-E-R/kiki-plugins ，20 个官方包）把设备控制接进了同一个工作台：

- `kiki-phone`：基于 Mobilewright / Mobile MCP 与热连 `scrcpy` 操作实体安卓 / iOS 手机（支持 root `su`）
- `kiki-cua`：本机多屏高分桌面操控（Windows / macOS / Linux）与跨插件远控总线
- `kiki-uu-remote`：网易 UU 远程、Proxmox VE 虚拟机（SSH 隧道无损 RFB 3.8 直连 + QMP/QGA 兜底）及 VNC 桌面，并桥接到 `kiki-cua`
- 三个远控面板均支持 60fps 预览并跨会话切换常驻（`0ms` 重开），带一键人工接管防抢锁（人一动鼠标/点接管立刻中止代理动作）

另外 0.7 底座补齐了三项长线工程能力：后台 CPU Worker 流式建索引让 3GB+ 跑了几周的长会话依然亚秒级冷打开、不卡主界面；缓存安全的上下文压缩保留压缩边界前的 KV-cache 前缀（250k+ 长跑仍保住 `>=99%` 命中率），不至于做完摘要后 token 费用暴涨；长期常驻的工程/调研/巡检会话除了多角色 `Room` 讨论外，还可以直接通过 `ThreadSend` / `ThreadRead` / `ThreadWait` 与 `@Thread` 引用互通消息和互相唤醒。

此外还有本地 PDF/Office 提取（`kiki-extract`）、Word/Excel/PPT 编辑（`kiki-office`）、CSV 核对（`kiki-work`）、图像/视频/语音/3D 生成（`kiki-media`）、需求看板（`kiki-task-board`）、历史导入（Claude Code / Codex / OpenCode 等）与 `kiki acp` / `kiki seat`。

## 下载与实话

- 直接从 GitHub Releases 下载桌面安装包（Win / macOS / Linux）或安卓 APK；Linux/macOS 独立 CLI 可用 `install.sh` 一行安装；npm 安装 `npm i -g kiki-agent`（Node 24.22.1+ 或 26.12.1+）。
- **实话：** 仍在 `0.x`（当前公开版 `0.6.2`，`0.7.0` 候选即将发布），有毛刺；macOS `.dmg` 未签名未公证，首次打开需按住 Control 点按打开；0.7 的 Windows 桌面安装包已内置自包含 Git Bash 与 `rg`（但仅用 npm 装 Windows CLI 仍需 Git for Windows）。截图是真实界面渲染的示例场景（`docs/public/shots/`），不做跑分对比。

仓库：https://github.com/X-T-E-R/kiki

欢迎佬们交流自己的多模型分工、自建 `kiki-relay` 部署方式，或者给国产模型写的配方。
