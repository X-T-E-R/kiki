# V2EX（分享创造）草稿（0.7.0）

**节点：** 分享创造

**标题：** 一个会话混编几家模型 + 手机自建加密中转连家里电脑控真机：开源本地智能体工作台 Kiki 0.7（MIT）

**正文：**

平时用 AI 写跨文件工程时，我有两个一直没被同时解决的需求：一是想在一个任务里把规划、实现、审查分给不同厂商的模型，而不是全烧同一个贵模型；二是人离开电脑时想用手机接着指挥家里电脑，甚至直接让它操作桌边的测试手机或内网虚拟机，同时不想把会话交给第三方云中转。

Kiki 是一个开源（MIT）的本地智能体工作台，作为本机服务运行，Electron 桌面应用、终端（`kiki`）、浏览器（`kiki web`）和安卓客户端看到的是同一场工作：https://github.com/X-T-E-R/kiki

主要能力：

- **按角色混编不同厂商的模型。** 主智能体通过 `AgentRun` 派出上下文隔离的子智能体：规划和验收用强模型，日常探查与范围清楚的实现交给便宜模型，审查再换另一家厂商避免共享盲区。每个子智能体是一份纯文本 Markdown（frontmatter 写工具、`model_alias`、思考档位和允许派发的子角色，正文是系统提示词），改完下次派发立即生效；没绑模型也没配默认模型时会直接报 `model.not_configured`，不会悄悄回退去烧贵模型。
- **每个模型都有自己的专武（Recipe）+ 单字段覆写。** 原生运行的模型可以绑定安装式配方（Recipe），把提示词、模型设置和可选脚本 Hook 打包管理。公开仓库 https://github.com/X-T-E-R/kiki-recipes （MIT）发布了五套（GPT-6.1 Sol、GPT-6 Astra、DeepSeek V4.1、Gemini 4 Argon、Gemini 3.8 Flash）。只想改单条工具描述也可以按模型覆写，用 `kiki prompt-fields explain <字段> --model <别名>` 查生效文本和完整来源链。
- **双模式安卓端 + 自建端到端加密中转（`kiki-relay`）。** 安卓版（`Kiki_*_android-release.apk`）首次启动可选「连接电脑 Kiki」（经局域网或 `kiki-relay` 远端连接，不拉起手机本地运行时）或「在本机运行 Kiki」（在安卓内嵌 Bionic Node 本地独立运行），并支持 SHA-256 与签名证书校验的应用内更新。家里电脑无公网 IP 时，可自建单文件 Node.js / Docker 的 `kiki-relay` 反向连接池，内层流量全程端到端 TLS 1.3 并固定到本机空间的 P-256 SPKI 指纹，中转节点不解密。
- **真机、桌面与远程虚拟机控制 + 办公扩展。** 官方插件目录（https://github.com/X-T-E-R/kiki-plugins ，20 个官方包）按需独立安装：`kiki-phone`（实体安卓/iOS 手机控制）、`kiki-cua`（本机多屏高分桌面控制）、`kiki-uu-remote`（网易 UU 远程、Proxmox VE 虚拟机 RFB 3.8 直连与 VNC 桌面），全部带工作台实时预览与一键人工接管防抢锁；此外还有本地 PDF/Office 提取（`kiki-extract`）、Word/Excel/PPT 编辑（`kiki-office`）、CSV 核对（`kiki-work`）、图像/视频/语音/3D（`kiki-media`）、需求看板（`kiki-task-board`）、历史导入（Claude Code / Codex / OpenCode 等）及 `kiki acp` / `kiki seat`。

说明与限制：当前仍在 `0.x`（公开版 `0.6.2`，`0.7.0` 候选即将发布），细节仍在打磨；macOS 安装包未签名也未公证（首次打开需按住 Control 点按打开）；0.7 的 Windows 桌面安装包已内置自包含 Git Bash 与 `rg`，干净的 Windows 装完即可用（若仅通过 npm 装 Windows CLI 仍需 Git for Windows；npm 需 Node.js 24.22.1+ 或 26.12.1+；Linux/macOS 也提供免 Node 的 `install.sh` 独立二进制）。仓库截图由真实界面渲染示例场景（`docs/public/shots/`），不代表性能跑分。项目最初 fork 自 Kimi Code，现独立开发。

[图：docs/public/shots/workbench/workbench-per-role-models.zh.png（多模型派发树，示例画面）]
[图：docs/public/shots/freedom/d02-prompt-fields.zh.png（提示词字段覆写，示例画面）]

想和大家交流：你在混编强模型与便宜模型时怎么拆分工，以及跨设备远程操控自己电脑和真机时最关心哪些安全边界。
