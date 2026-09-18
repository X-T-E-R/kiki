# 界面导览

Kiki 桌面版与浏览器 GUI 共享同一套界面。一个会话由三个区域组成：对话视图、输入框和右侧栏。本页带你熟悉界面布局；看板、草稿与恢复见[工作区与会话管理](/zh/guides/sessions)，TUI 侧对应操作见[交互与输入](/zh/guides/interaction)。

## 对话视图

对话视图展示会话时间线：assistant 消息、工具调用、审批、提问和后台任务通知。已解决的问题、审批、标记和完成通知以单行紧凑条目保留在原位；连续条目折叠进可展开的「Activity history」行，失败或取消的条目始终单独可见。文件引用可以预览、打开或在所在文件夹中显示。

## 输入框

输入框接受自由文本：`Enter` 发送，`Shift-Enter` / `Ctrl-J` 插入换行。输入框为空时按 `↑` / `↓` 浏览当前工作目录的历史输入。可以从剪贴板粘贴图片和视频，取决于当前模型的多模态能力——完整行为见[交互与输入](/zh/guides/interaction)，GUI 输入框与其共享同一套规则。

## 审批

修改文件或运行 Shell 命令的操作会以审批请求的形式出现在时间线中。每个请求在执行前会列出操作内容；你可以批准一次或批准整个会话。只读操作默认自动执行。用 `Esc` 中断的工具调用在执行前停止。

## 右侧栏

主 Agent 的右侧栏包含工作区选择器、任务看板入口（底部固定按钮——见[任务看板](/zh/guides/sessions#requirements-board)），以及展示当前 Agent 工具目录的会话面板。在面板中打开 **Dispatch capabilities** 可以查看 subagent profile、route、executor 及默认模型与思考力度来源；见 [Agent 与 subagent](../customization/agents.md#rebuilding-a-session-context)。

## 会话与工作区

会话列表按工作区分组；选择一个恢复，或新建草稿。已保存但不再可用的模型、profile 或思考力度会带着诊断信息继续可见，由你选择有效值——GUI 不会悄悄替换成另一个模型。详情见[工作区与会话管理](/zh/guides/sessions)。

## 下一步

- [工作区与会话管理](/zh/guides/sessions) —— 会话、任务看板、使用统计
- [设置页导览](./settings.md) —— 桌面版各设置品类一览
- [交互与输入](/zh/guides/interaction) —— 这些概念在 TUI 侧的对应操作
