# 小红书图文与 35–45 秒分镜（轮播 8 张，0.7.0）

开头第一句：出门用 5G 手机给家里电脑派活，改完代码直接唤醒桌边测试真机自己跑完验收——背后是同一个开源本地多模型工作台。

如果发 35–45 秒短视频，优先按 [demo-storyboard.md](demo-storyboard.md) Storyboard A（手机 → 加密中转 → 家里电脑 → 桌面真机实拍分屏）或 Storyboard B（多模型分工 + 独立审查抓 Bug）；如果发图文，用真实录屏帧或 `docs/public/shots/` 示例场景截图（非录屏标「示例画面」）。竖版 3:4（1242×1656），暖纸浅色底，每张一句大字加最多一行小字，四周留白。

| # | 画面（轮播图） | 图上大字 | 图上小字 |
| --- | --- | --- | --- |
| 1 封面 | 分屏实拍或 `workbench-per-role-models.zh.png` | 手机直连家里电脑，几家模型分工干活 | 桌面 · 终端 · 安卓 · 真机控制 · MIT 开源 |
| 2 | 派发树特写 + 后台完成通知（`d04-tool-steps-notification.zh.png`） | 让贵的模型只干它擅长的那一步 | 强模型规划，便宜模型实现，换一家模型审 |
| 3 | 设置 Recipe 面板 + `d02-prompt-fields.zh.png` | 每个模型都有自己的专武 | 装一次 Recipe 配方，管提示词和模型设置 |
| 4 | 排队消息条展开「发送时机」（`long-work-goal-queue.zh.png`） | 它忙它的，我说我的 | 每条消息单选：空闲后 / 子代理完成后 / 任务完成后 |
| 5 | 跨设备自建 `kiki-relay` + 双模式安卓端示意图/实拍 | 没公网 IP 也能跨网直连 | 自建加密中转，内层 TLS 1.3 证书固定 |
| 6 | 真机与桌面预览面板实拍，或 `d01-agent-preview.zh.png` | 同一个会话直接操作真机与桌面 | kiki-phone / kiki-cua / kiki-uu-remote · 一键人工接管 |
| 7 | Markdown 智能体文件（`r01-reviewer-profile.zh.png`） | 每个智能体就是一份文件 | 可从 Claude Code / Codex 导入历史接着聊 |
| 8 结尾 | Releases 下载页与多端清单 | 数据留在自己机器上 | GitHub 搜 X-T-E-R/kiki · MIT 开源 |

## 正文

让贵的模型只干它擅长的那一步，再把桌面、终端、手机和真机连成一个工作台。

Kiki 是我做的开源（MIT）本地智能体工作台，跑在自己电脑上，Electron 桌面端、终端、浏览器和安卓客户端看到的是同一场工作。

0.7 版本把最常用的几条线都接通了：
- **多模型同场分工**：主会话用强模型规划和验收，探索和局部改动交给便宜模型，审查再换另一家厂商避免自己审自己
- **每个模型有自己的专武（Recipe）**：提示词、模型设置和脚本 Hook 装一次绑给模型，公开仓库已经发了五套（GPT-6.1 Sol、GPT-6 Astra、DeepSeek V4.1、Gemini 4 Argon、Gemini 3.8 Flash）
- **双模式安卓 + 自建加密中转**：安卓版既能经局域网或自建端到端加密 `kiki-relay` 直连家里电脑，也能直接在手机里用内置 Bionic Node 本地独立运行
- **真机、桌面与办公插件**：装上官方插件就能在同一个会话里操作实体安卓/iOS 手机（`kiki-phone`）、本机桌面（`kiki-cua`）、UU 远程 / PVE 虚拟机（`kiki-uu-remote`），或者本地拆 PDF、改 Word/Excel/PPT、核对 CSV 表格

工作文件、会话和配置留在自己电脑上，模型请求只发往你自己连接的供应商或本地服务。目前还是 `0.x`（公开版 `0.6.2`，`0.7.0` 候选发布中），macOS 安装包未签名；0.7 的 Windows 桌面安装包已自带 Git Bash 和 `rg`，装完就能直接跑。

GitHub 搜 `X-T-E-R/kiki`（插件库 `X-T-E-R/kiki-plugins`，配方库 `X-T-E-R/kiki-recipes`）。

## 标签

#AI编程 #程序员日常 #开源项目 #AI工具 #效率工具 #DeepSeek #独立开发 #大模型
