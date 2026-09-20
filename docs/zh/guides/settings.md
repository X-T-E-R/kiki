# 设置页导览

Kiki 桌面版把设置集中在 **Settings** 对话框里。本页帮你快速定位每个设置在哪里、点进去能改什么；底层配置的完整说明见各节链接的参考页。

**「我想改 X」速查表：**

| 我想改… | 去哪里 |
| --- | --- |
| 版本与更新通道（Stable / Beta） | **About** |
| Agent 配置档案、提示词覆写 | **Agents** |
| 搜索与抓取的配置来源 | **Search & retrieval** |
| 输入框草稿是否记住 | **输入框（Composer）** |
| subagent 派发配置 | **Dispatch capabilities** |
| Token 用量与费用 | **Usage** |
| TUI 主题、编辑器等 CLI 侧偏好 | 终端里的 `/config` 等命令，见 [CLI 侧对应](#cli-侧对应) |

## About

**Settings → About** 显示当前版本和更新通道。选择 Stable 或 Beta 并手动检查更新；有更新时，Kiki 会先展示版本号和发布说明再请求确认。见 [Kiki 桌面版](../getting-started/desktop-app.md#更新)。

## Agents

**Settings → Agents** 选择一个工作区，查看其默认主 Agent 配置档案（profile）、生效来源和 subagent 能力。文件型 profile 可在其显示的来源处直接编辑。**Settings → Agents → Prompt** 编辑 `config.toml` 中的 `[prompt]` 提示词字段覆写段；卡片默认折叠——编辑前先展开。见 [Agent 与 subagent](../customization/agents.md#派遣能力可见性) 和[提示词字段与覆写](../customization/prompt-fields.md)。

## Search & retrieval

**Settings → Search & retrieval → Overview & source** 查看内置搜索与抓取模块（`WebSearch` 和 `FetchURL` 两个工具背后的能力）当前生效的配置来源，并控制服务器是否复用本机的搜索配置。对应的配置位于 `config.toml` —— 见[配置文件](../configuration/config-files.md#nb-search)。

## 输入框（Composer）

**输入框 → 保留输入草稿** 开关（英文界面为 Composer → Persist composer drafts）控制新会话选择（模型、思考强度、工作区、工作目录、profile）和每个会话的草稿文本是否写入当前浏览器。关闭开关会清空已保存的存储。见[工作区与会话管理](./sessions.md#会话存储)。

## Dispatch capabilities

打开 **Dispatch capabilities**（派发能力面板）—— 位于新会话工作区选择器旁，或某个会话的右侧栏 —— 查看 subagent 的 profile（配置档案）、route（路由）与 executor（执行器），以及默认模型与思考强度的来源。默认配置的有效性与启动权限分开显示。见 [Agent 与 subagent](../customization/agents.md#重建会话上下文)。

## Usage

**Usage** 页展示某个日期范围的 token 用量与估算成本。不带筛选打开时默认为今天；token 用量与成本有各自的完整度指示，**Data reliability** 区分未知平台与空区间。见[工作区与会话管理](./sessions.md#gui-用量统计)。

## CLI 侧对应

TUI 不使用 **Settings** 对话框：终端里的客户端偏好（主题、编辑器等）通过 `tui.toml` 和交互命令 `/config`、`/theme`、`/editor` 配置，见 [`tui.toml`](../configuration/config-files.md#tui-toml)；Agent 与运行时设置位于 `config.toml`。
