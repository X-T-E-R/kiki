# 设置页导览

Kiki 桌面版在 **Settings** 对话框中集中展示设置。本页导览各设置品类，并链接到拥有底层配置的参考页；本页不引入新行为。

## About

**Settings → About** 显示当前版本和更新通道。选择 Stable 或 Beta 并手动检查更新；有更新时，Kiki 会先展示版本号和发布说明再请求确认。见 [Kiki 桌面版](../getting-started/desktop-app.md#update)。

## Agents

**Settings → Agents** 选择一个工作区，查看其默认主 profile、有效来源和 subagent 能力。文件型 profile 可在其显示的来源处直接编辑。**Settings → Agents → Prompt** 编辑 `config.toml` 中的 `[prompt]` 提示词字段覆写段；卡片默认折叠——编辑前先展开。见 [Agent 与 subagent](../customization/agents.md#capability-visibility) 和[提示词字段与覆写](../customization/prompt-fields.md)。

## Search & retrieval

**Settings → Search & retrieval → Overview & source** 查看网页搜索来源并控制复用。对应的配置位于 `config.toml` —— 见[配置文件](../configuration/config-files.md#nb-search)。

## Composer

**Composer → Persist composer drafts** 开关控制新会话选择（模型、思考力度、工作区、工作目录、profile）和每个会话的草稿文本是否写入当前浏览器。关闭开关会清空已保存的存储。见[工作区与会话管理](./sessions.md#session-storage)。

## Dispatch capabilities

打开 **Dispatch capabilities** —— 位于新会话工作区选择器旁，或某个会话的右侧栏 —— 查看 subagent profile、route、executor 及默认模型与思考力度来源。默认配置的有效性与启动权限分开显示。见 [Agent 与 subagent](../customization/agents.md#rebuilding-a-session-context)。

## Usage

**Usage** 页展示某个日期范围的 token 用量与估算成本。不带筛选打开时默认为今天；token 用量与成本有各自完整度指示，**Data reliability** 区分未知平台与空区间。见[工作区与会话管理](./sessions.md#gui-usage-statistics)。

## CLI 侧对应

TUI 通过 `tui.toml` 和交互命令 `/config`、`/theme`、`/editor` 写入同一类客户端偏好；见 [`tui.toml`](../configuration/config-files.md#tui-toml)。Agent 与运行时设置位于 `config.toml`。
