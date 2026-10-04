# Hooks

Hooks（钩子）订阅引擎事件。声明式 v2 规则无需启动进程，就能附加指导文本或观察事件；legacy（旧协议）hooks 则执行本机 Shell 命令。典型的使用场景：

- **安全拦截**：Agent 要执行 Shell 命令前，检查是否包含危险操作（如 `rm -rf`），包含则阻断执行
- **桌面通知**：后台任务完成时，弹出系统通知提醒你回来查看结果
- **自动检查**：每次用户提交消息时，自动在上下文里附加一些背景信息（如当前 Git 分支）

## 声明式规则（v2）

固定指导文本优先用 v2，例如每完成五步提醒一次。把下面的配置写入[用户配置文件](../configuration/config-files.md)，将 `example-model` 换成已配置的模型键或别名：

```toml
[hooks]
schema_version = 2

[[hooks.rules]]
id = "evidence-check"
event = "step.before"
priority = 100

[hooks.rules.match]
models = ["example-model"]
executors = ["native"]
agent_roles = ["root", "subagent"]

[hooks.rules.cadence]
every_completed_steps = 5
counter_scope = "agent"
partition_by = "model"

[hooks.rules.action]
type = "inject"
text = "继续前核对目标、已有证据和下一步。"
```

一步指一次模型响应及其全部工具结果已落定并提交，不是一次工具调用或重试尝试。完成五步后，提醒在下一次模型请求前送达。第五步若恰好结束本轮，不会额外创建轮次，而是等待该模型的下一个请求。计数属于各 Agent 和模型配置的规范身份，因此 A → B → A 切换会保留 A 的计数；`counter_scope = "turn"` 则在新轮次清零。恢复、压缩和 undo 不倒拨计数，也不重放已投递提醒。修改 matcher 或节拍会开启从零计数的新语义 revision；只修改文本，会在下一个到期点使用新文本。

当前 v2 只接受 `inject` 和 `observe` 动作。`inject` 可用于 `step.before` 和 `prompt.submit`；`observe` 除这两个事件外，还支持 `step.after`、`tool.before`、`tool.after`、`turn.stopping`、`turn.after` 和 `session.start`。节拍仅适用于 step 事件。观察器只记录元数据，不改变原操作。v2 的 `command`、`block`、`gate` 和 `continue` 动作会在加载时被拒绝；脚本自动化仍使用下文的 legacy 协议。

### 来源与匹配

用户配置、已信任项目的 `.kiki/hooks.toml` 和已启用插件 manifest 的规则组合执行，分别使用 `user/evidence-check`、`workspace/check`、`plugin/example/check` 等全限定 ID。`priority` 较小的先执行，同优先级按全限定 ID 排序；没有模型规则覆盖 profile 规则的优先链。同一命名空间的重复 ID 是错误，不同命名空间可使用相同短 ID。未信任项目的规则仍可查看，但不激活，纯文本规则也不例外。

`match.models`、`profiles`、`routes`、`executors` 和 `agent_roles` 使用精确值。不同字段必须同时命中，同一字段内的多个值是备选项，省略字段表示不限。模型别名在加载时解析，因此拼错别名会在首个请求前报告。工具名用 `match.tools`；工具结果状态用 `match.statuses`（`success`、`error`、`cancelled`、`denied`）。`prompt.submit` 默认仅匹配 `source = user`，其他来源需在 `match.sources` 中显式选择。无法提供 native step/tool 拦截的外部 executor 在检查视图中标为 unsupported，不会靠工具数量模拟步数。

长文本可用 `text_file = "reminders/check.md"` 替代 `text`，二者互斥；`[hooks] files = ["hooks.toml"]` 可包含其他 v2 文档。路径相对于声明文件，经过 realpath（解析符号链接后的真实路径）检查后仍须留在该来源的作用域内。include 不能是 URL、不能循环或重复加载。缺文件、空文本、不支持的动作、无效节拍，以及超过 8 KiB UTF-8 字节预算的注入，都会形成加载期诊断。指导文本作为带来源标记的对话上下文投递，不替换系统提示词，也不能覆盖更高层指令。

在规则上设 `enabled = false` 可停用该规则。用户 section 可用 `disabled = ["workspace/check"]` 停用任意来源的全限定 ID，或用 `enabled = false` 停用全部 v2 规则。项目和插件只能停用自身规则。变更在下一个安全事件边界生效，当前事件保留其配置快照。

### 查看有效规则

引擎贡献命令 `hooks-inspect` 输出来源、激活或失败原因、执行顺序、绑定、语义 revision、已完成计数和下一次到期计数。可通过现有客户端命令 API 调用：

```ts
await klient.session(sessionId).agent("main").runCommand({ name: "hooks-inspect" });
```

结果是 `hook.result` 诊断事件（`hookEvent = "hooks.inspect"`），不会附加到模型对话。在 GUI 中，展开会话 Agent 面板的 **Hooks**，可查看有效规则、来源路径、未激活原因和计步状态。此视图使用 `GET /api/sessions/{session_id}/agents/{agent_id}/hooks`；配置保存成功不代表规则已在该会话激活。

编辑用户配置时，打开**设置 → 能力 → 钩子**（`/settings/hooks`）。选中声明式规则或命令规则进行编辑，也可用 **高级：编辑 JSON** 编辑完整的 legacy 数组或 v2 对象。添加第一条声明式规则会显式切换到 v2，并把原命令保留在 `legacy` 中；打开或保存页面不会执行这些命令。**保存自动操作** 会校验完整的 hooks 值，并显示服务器保存后的值；保存失败时保留草稿。v2 总开关和停用 ID 仅影响声明式规则，不影响命令规则。

TOML 不能在同一个 key 下同时声明 `[[hooks]]` 和 `[hooks]`。已有数组继续保持原义。需要在 v2 文档中保留 legacy 命令时，显式把旧条目移至 `[[hooks.legacy]]`，保持 `event`、`matcher`、`command` 和以秒计的 `timeout` 不变；它们仍使用 legacy runner 和输出协议，不会自动迁移或转换脚本协议。

## Hooks 是怎么工作的

以下章节描述 legacy 命令协议，不是 v2 声明式规则。

配置一条 hook 规则，需要指定三件事：**在什么事件上触发**、**匹配哪些目标**、**运行哪个脚本**。

触发时，CLI 会把事件的详细信息（触发原因、工具名称、命令内容等）打包成 JSON（一种结构化文本格式），通过**标准输入**（stdin，程序运行时用来接收外部数据的通道）传给你的脚本。脚本读取这些信息后，决定怎么响应。

脚本的响应结果由两样东西决定：

- **退出码**（exit code，程序结束时向操作系统报告的状态数字）：`0` 表示放行；非零值在阻断类事件上阻止原操作，纯观察事件则继续。
- **标准输出**（stdout，就是你用 `console.log` 或 `print` 打印出来的内容）：可以附带说明文字。

阻断类事件在脚本失败或超时时采用 fail-closed（失败即拒绝）：尚未执行的操作停止，并提供原因。纯观察事件不打断主流程。[返回值表](#返回值)列出两类行为。

::: warning 注意
Hooks 是权限系统的补充，不是操作系统沙箱，也不能代用户批准工具执行。高风险操作仍应保留权限检查和人工确认。
:::

## 快速上手：一个最简单的 hook

下面这条 hook 会在每次后台任务完成时，在终端标题栏闪一下通知（macOS 需要安装 `terminal-notifier`）：

```toml
# 写在 ~/.kiki/config.toml 里
[[hooks]]
event = "Notification"           # 触发时机：后台任务状态变化时
matcher = "task\\.completed"     # 只关心"已完成"的通知
command = "terminal-notifier -title Kimi -message 'Task done'"
```

保存配置、重开会话，下次后台任务完成时就会弹出通知。

## 配置

所有 hook 规则写在 `~/.kiki/config.toml` 的 `[[hooks]]` 数组里，每一项是一条规则：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `event` | `string` | 是 | 触发事件名，必须是下文「事件一览」表中的某一项 |
| `matcher` | `string` | 否 | 用正则表达式（一种字符串匹配语法）过滤事件目标；不填则匹配全部 |
| `command` | `string` | 是 | 触发时要运行的 Shell 命令 |
| `timeout` | `integer` | 否 | 超时秒数，范围 1–600；默认 30 秒 |

`[[hooks]]` 只允许这四个字段，多写会导致配置文件加载失败。

**同一事件匹配多条规则时**，所有命中的 hook 并行运行；`command` 完全相同的多条规则只运行一次。

Hook 命令的工作目录是当前会话的项目目录。非 Windows 平台上，hook 进程放在独立进程组里，超时时先发信号让它有机会善后，之后才强制终止。

### 事件数据格式

每次触发时，CLI 都会把以下基础信息通过 stdin 传给脚本：

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "session_title": "修复登录页",
  "client_type": "kimi_code_cli",
  "cwd": "/path/to/project"
}
```

具体事件还会附带额外字段（如工具名称、命令内容），见下方事件一览。所有字段名使用下划线命名（snake_case）。

## 返回值

脚本结束后，CLI 根据退出码判断 hook 的意图：

| 退出码 | 含义 | CLI 怎么处理 |
| --- | --- | --- |
| `0` | 正常结束，放行 | 继续执行，若标准输出（stdout）有内容可附加到上下文 |
| `2` | 主动阻断 | 停止当前操作；错误输出（stderr，`console.error` 打印的内容）作为阻断原因 |
| 其他非零值 | 脚本出错 | 阻断类事件停止当前操作（fail-closed）；纯通知类事件继续 |
| 超时或崩溃 | 脚本异常 | 阻断类事件停止当前操作（fail-closed）；纯通知类事件继续 |

### JSON 协议判定

退出码为 `0` 时，CLI 按以下规则判断标准输出：

- **有效 JSON**：CLI 会递归检查对象和数组。如果任意深度的对象自身含有 `message` 或 `hookSpecificOutput` 键，该输出就属于协议尝试，且顶层值必须符合严格的 hook 响应对象格式。顶层形态不同或协议字段非法时，阻断类事件会被阻断。完全不含这两个键的 JSON 仍视为非结构化输出并放行。
- **畸形对象文本**：只有呈对象形态、且含有可识别的精确 `message` 或 `hookSpecificOutput` 键时，文本才属于协议尝试。以 `[` 开头的文本只有在第一个非空白字符是 JSON 值起始符时才视为数组形态，因此 `[INFO]` 和 `[DEBUG]` 日志仍是非结构化输出。键识别能覆盖单引号、缺少分隔符、键和值之间漏冒号等常见错误，同时不会把 `messageCount` 这类前缀当成协议键。已识别的畸形协议尝试会阻断阻断类事件。
- **残余歧义文本**：如果畸形文本中没有可识别的精确协议键，CLI 无法可靠地将其与普通日志区分，因此仍按非结构化输出放行。这包括 `[INFO] response contains "message": metadata` 这类日志。

也可以通过标准输出返回一段 JSON 来阻断：

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "请用 rg 代替 grep"
  }
}
```

::: info 哪些事件支持阻断？
只有**可阻断事件**（`PreToolUse`、`Stop`、`UserPromptSubmit`）的返回值会影响主流程。其余事件属于**观察型事件**——触发后即发即忘，不管脚本返回什么，主流程都不会改变。
:::

## 事件一览

| 事件 | Matcher 匹配的是 | 会触发阻断？ | 说明 |
| --- | --- | --- | --- |
| `UserPromptSubmit` | 用户提交的文本内容 | ✓ | 用户发送消息时触发；返回文本会附加到上下文；若阻断，本轮不调用模型 |
| `UserPromptQueued` | 排队消息的文本内容 | — | 上一回合仍在运行、消息进入队列时触发；payload 含 `prompt_id`、`prompt` 和 `queue_length`（观察用） |
| `PreToolUse` | 工具名 | ✓ | 工具调用前触发（权限检查前）；阻断后工具不会执行 |
| `Stop` | 空字符串 | ✓ | 模型准备结束本轮时触发；阻断后可追加一条消息让模型继续 |
| `TurnStarted` | 回合来源类型（如 `user`、`task`、`system_trigger`） | — | 新回合开始时触发；payload 含 `turn_id`、`origin_kind`、`origin_name` 和 `prompt`（观察用） |
| `PostToolUse` | 工具名 | — | 工具成功执行后触发（观察用） |
| `PostToolUseFailure` | 工具名 | — | 工具失败或被阻断后触发（观察用） |
| `PermissionRequest` | 工具名 | — | 即将等待用户审批前触发（观察用） |
| `PermissionResult` | 工具名 | — | 审批结束后触发（观察用） |
| `SessionStart` | `startup` 或 `resume` | — | 新会话启动或历史会话恢复后触发；payload 含 `source`、`model` 和 `profile` |
| `SessionEnd` | `exit` 或 `archive` | — | 会话关闭后触发；`archive` 表示会话被归档而非退出 |
| `SessionHeartbeat` | 空字符串 | — | 会话存活期间每 60 秒触发一次；仅当配置了本事件时计时器才会运行。payload 含 `uptime_ms`（观察用） |
| `SubagentStart` | subagent 名称 | — | subagent 开始运行前触发 |
| `SubagentStop` | subagent 名称 | — | subagent 成功完成后触发（观察用） |
| `TaskStarted` | 任务类型（`agent`、`process` 或 `question`） | — | 后台任务启动时触发；payload 含 `task_id`、`description` 和 `detached`（观察用） |
| `StopFailure` | 错误类型 | — | 本轮因错误失败后触发（观察用） |
| `Interrupt` | 空字符串 | — | 用户中断本轮时触发（例如按下 Esc）；超时或其他程序性中断不会触发。中断时 `Stop` 不会触发，由本事件替代。payload 含 `reason` 字段（观察用） |
| `PreCompact` | `manual` 或 `auto` | — | 上下文压缩开始前触发；返回值被完全忽略 |
| `PostCompact` | `manual` 或 `auto` | — | 上下文压缩完成后触发（观察用） |
| `Notification` | 通知类型（如 `task.completed`） | — | 后台任务状态变化时触发（观察用） |

## 示例：阻断危险 Shell 命令

下面的 hook 在 Agent 调用 `Bash` 工具前检查命令内容，发现 `rm -rf` 就阻断：

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kiki/hooks/block-dangerous-bash.mjs"
timeout = 5
```

```js
// block-dangerous-bash.mjs
// 从 stdin 读取 CLI 传来的事件数据
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);         // 解析事件数据
  const command = payload.tool_input?.command ?? '';

  if (command.includes('rm -rf')) {
    // 通过 stderr 说明阻断原因，退出码 2 表示阻断
    console.error('检测到危险命令，已阻断');
    process.exit(2);
  }
  // 正常退出（退出码 0）表示放行
});
```

阻断后，Kiki 会把阻断原因写回上下文，模型可以据此选择更安全的替代方案。

::: warning 注意
此示例仅演示阻断机制，不是生产级的安全解析器。真实场景更适合用白名单，或用专门的 Shell 解析器处理引号、变量展开和多段命令。
:::

## 下一步

- [配置](#配置) — `[[hooks]]` 在 `config.toml` 中的完整字段声明
- [Agent 与 subagent](./agents.md) — 利用 `SubagentStop` 事件在 subagent 完成后触发通知
