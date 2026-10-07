# Hooks

Hooks 用来响应引擎事件。声明式（v2）规则不需要启动任何进程，就能附加指导文本或观察事件；legacy hook 则执行本机 Shell 命令。常见用途：

- **拦截风险操作**：Shell 命令执行前检查是否包含 `rm -rf` 之类的危险操作并阻断
- **桌面通知**：后台任务结束时弹出系统通知，提醒你回来看结果
- **补充上下文**：把模型应该始终看到的信息（如当前 Git 分支）附加到每条提交的消息上

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

一步指一次模型响应连同其全部工具结果已提交，不是一次工具调用。完成五步后，提醒会在下一次模型请求前注入；若第五步恰好结束了本轮，它会等该模型的下一个请求，不会为此新开一轮。计数按 Agent 和模型规范身份分别记录，A → B → A 仍保留 A 的计数，`counter_scope = "turn"` 则在新轮次清零。恢复、压缩和 undo 既不倒拨计数也不重放提醒；改 matcher 或节拍会从零开始新计数，只改文本则在下一个到期点用新文本。

目前只有 `inject` 和 `observe` 两种动作。`inject` 用于 `step.before` 和 `prompt.submit`；`observe` 除这两个事件外还支持 `step.after`、`tool.before`、`tool.after`、`turn.stopping`、`turn.after` 和 `session.start`，只记录元数据。节拍仅适用于 step 事件。写 `command`、`block`、`gate` 或 `continue` 会在加载时被拒绝，它们属于下文的 legacy 协议。

### 来源与匹配

规则来自用户配置、已信任项目的 `.kiki/hooks.toml` 和已启用插件的 manifest，并各自带上 `user/evidence-check`、`workspace/check` 这样的全限定 id。`priority` 小的先执行，同优先级按全限定 id 排序。同一命名空间内 id 重复是错误，不同命名空间用相同短 id 没问题。未信任项目的规则仍可见但不激活，纯文本规则同样如此。

`match.models`、`profiles`、`routes`、`executors` 和 `agent_roles` 取精确值：你写了几个字段就必须同时命中，同一字段里的多个值是备选项，省略即不限。模型别名在加载时解析，拼错会在第一个请求前报出来。工具名写在 `match.tools`，工具结果写在 `match.statuses`（`success`、`error`、`cancelled`、`denied`）。`prompt.submit` 默认只匹配 `source = user`，包括通过「立即发送」投递的人类输入；任务或邮箱来源需在 `match.sources` 中写 `task` 或 `mailbox`。`sources = ["steering"]` 匹配「立即发送」投递路径，不限原生产者，也不会把邮箱消息变成用户输入。无法原生拦截 step 或 tool 的外部 executor 会被标为不支持，而不是靠工具调用次数模拟。

长文本可以用 `text_file = "reminders/check.md"` 代替 `text`（二者互斥），`[hooks] files = ["hooks.toml"]` 可以引入其他 v2 文档。路径相对于声明文件，解析后必须仍在其来源作用域内；include 不能是 URL、不能重复或形成循环。缺文件、空文本、不支持的动作、无效节拍以及超过 8 KiB 的注入都是加载期错误。注入的指导文本是带来源标记的对话上下文，不替换系统提示词，也无法覆盖更高优先级的指令。

在规则上设 `enabled = false` 可停用。用户配置可以用 `disabled = ["workspace/check"]` 停用任意来源的规则，也可以用 `enabled = false` 关掉全部 v2 规则；项目和插件只能停用自己的。改动在下一个安全事件边界生效。

### 查看生效规则

`hooks-inspect` 命令会报告每条规则的来源、生效或失败原因、执行顺序、绑定、已计数和下一次到期计数：

```ts
await klient.session(sessionId).agent("main").runCommand({ name: "hooks-inspect" });
```

结果是 `hook.result` 诊断事件（`hookEvent = "hooks.inspect"`），不会进入模型对话。GUI 里会话 Agent 面板的**自动规则**显示同样的信息，读取 `GET /api/sessions/{session_id}/agents/{agent_id}/hooks`——规则保存成功但在该会话未激活时，原因就显示在这里。没有配置任何规则、也没有需要修复的来源时，这个区块整个不出现。

在**设置 → 能力 → 钩子**（`/settings/hooks`）里编辑用户配置：选中规则直接编辑，或用 **高级：编辑 JSON** 处理整个 legacy 数组或 v2 对象。添加第一条声明式规则会把 legacy 数组切换为 v2，原命令保留在 `legacy` 下；打开或保存这个页面都不会执行它们。**保存自动操作** 校验完整的 hooks 值并显示服务器实际保存的内容，保存失败时你的草稿还在。v2 开关和停用 id 只影响声明式规则。

TOML 不能在同一个 key 下同时写 `[[hooks]]` 和 `[hooks]`，已有数组继续照常工作。要在 v2 文档里保留 legacy 命令，把它们显式移到 `[[hooks.legacy]]`，保留 `event`、`matcher`、`command` 和以秒计的 `timeout`；它们仍按 legacy runner 和输出协议执行。

## Recipe 脚本 hooks

[Recipe 模型配方](./prompt-fields.md#recipe-模型配方)可以携带脚本，只为引用它的原生模型或 profile 绑定运行。在 `recipe.toml` 中声明 hook，并列出命令需要的全部 UTF-8 脚本和配套文件：

```toml
[[hooks]]
event = "UserPromptSubmit"
command = "node hooks/cue.mjs"
files = ["hooks/cue.mjs"]
timeout = 5
```

`hooks/cue.mjs` 从标准输入接收事件 JSON，按既有[脚本响应协议](#返回值)返回指导文本：

```js
let input = '';
for await (const part of process.stdin) input += part;
const event = JSON.parse(input);
if (event.hook_event_name === 'UserPromptSubmit') {
  console.log(JSON.stringify({ message: '回答前核对目标和已有证据。' }));
}
```

预览列出实际命令、事件、来源和资源指纹。含脚本的包安装时只需明确确认一次，授权这一份执行内容。脚本以 Kiki 服务端的操作系统用户运行，能访问该主机的文件和网络；它不是沙箱，也不改变 Agent 的工具权限。预览、打开编辑器或取消安装都不会运行脚本。无脚本的包不增加脚本确认，已接受的绑定或恢复的会话也不会每次触发都再问。

命令的工作目录是已接受资源快照的受管目录，不是作者的实时源目录。`KIKI_RECIPE_ROOT` 指向这个资源目录，事件 JSON 的 `cwd` 仍指会话工作区。使用主机已有的解释器，并按 Shell 规则为路径加引号。`matcher` 和 `timeout` 沿用下文的 legacy 字段，超时默认 30 秒，接受 1–600 的整数秒。路径必须留在包内，每个引用文本文件最多 256 KiB。可选 `root` 指定包内的相对资源目录，`files` 相对于它；导出的包用此字段隔离继承链中同名的脚本。

父子 hooks 追加，顶层 `hooks = "off"` 移除继承的脚本。模型和 profile 引用各自贡献；关闭某引用后，在下一次绑定或重建上下文时停止该层，包和原配置仍保留。已有会话继续使用冻结的脚本，安装包接受更新也不会暗中替换它，显式重建才采用新版本。

修改命令、脚本资源或执行来源后，要走同一套预览和确认才能发布；只改提示词、执行内容不变时不再问。自动 `follow` 更新遇到新脚本需要确认时保留旧版本。复制或继承已接受的 Recipe 会复用未变脚本的授权；导出只分享资源、不分享授权，因此接收者首次安装需要确认。

Recipe 脚本支持[事件一览](#事件一览)中的 Agent 绑定事件，不接受 `SessionStart`、`SessionEnd`、`SessionHeartbeat`、`SubagentStart` 和 `SubagentStop`；原用户与插件配置的这些事件照常工作。外部执行器不运行 Recipe 脚本。声明式的 `hooks-inspect` 视图不能证明脚本已执行，请核对脚本结果和目标事件的真实效果。

## Legacy 命令 hook

以下都是 legacy 协议：一条规则写明触发事件、要匹配的目标，以及要执行的 Shell 命令。

命中时，CLI 把事件详情（触发原因、工具名、命令内容等）打包成 JSON，通过**标准输入**（stdin，程序运行时接收外部数据的通道）传给脚本，由脚本决定怎么做。**退出码**（exit code，程序结束时向系统报告的状态数字）决定放行还是阻断——`0` 放行，非零值在阻断类事件上阻止原操作，纯观察事件则继续；**标准输出**（stdout，`console.log` 打印的内容）可以附带说明。

阻断类事件在脚本失败或超时时按 fail-closed 处理：尚未执行的操作停止并给出原因。纯观察事件不打断主流程。[返回值表](#返回值)列出两类行为。

::: warning 注意
Hook 是权限规则的补充，不是操作系统沙箱，也不能代你批准工具执行。高风险操作仍要保留权限检查和人工确认。
:::

## 一个最简单的 hook

下面这条 hook 会在每次后台任务完成时，在终端标题栏闪一下通知（macOS 需要安装 `terminal-notifier`）：

```toml
# 写在 ~/.kiki/config.toml 里
[[hooks]]
event = "Notification"           # 触发时机：后台任务状态变化时
matcher = "task\\.completed"     # 只关心"已完成"的通知
command = "terminal-notifier -title Kimi -message 'Task done'"
```

保存配置、重开会话，下次后台任务完成时就会弹出通知。

## Legacy 规则字段

每条 legacy 规则是 `~/.kiki/config.toml` 中 `[[hooks]]` 数组里的一项：

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

具体事件会附带各自的字段（工具名、命令内容等），见下方事件一览。所有字段名使用下划线命名（snake_case）。

## 返回值

脚本结束后，CLI 按退出码判断它的意图：

| 退出码 | 含义 | CLI 怎么处理 |
| --- | --- | --- |
| `0` | 正常结束，放行 | 继续执行，若标准输出（stdout）有内容可附加到上下文 |
| `2` | 主动阻断 | 停止当前操作；错误输出（stderr，`console.error` 打印的内容）作为阻断原因 |
| 其他非零值 | 脚本出错 | 阻断类事件停止当前操作（fail-closed）；纯通知类事件继续 |
| 超时或崩溃 | 脚本异常 | 阻断类事件停止当前操作（fail-closed）；纯通知类事件继续 |

### JSON 协议判定

退出码为 `0` 时，CLI 这样判断标准输出：

- **有效 JSON** 会被递归检查。任意深度的对象里出现 `message` 或 `hookSpecificOutput` 键，就认为这是协议输出，顶层必须符合严格的 hook 响应对象格式；顶层形态不同或协议字段非法时阻断该操作。两个键都没有的 JSON 仍是非结构化输出，放行。
- **畸形的对象文本** 只有在含有可识别的精确 `message` 或 `hookSpecificOutput` 键时才算协议尝试。以 `[` 开头时，只有第一个非空白字符能作为 JSON 值开头才按数组处理，因此 `[INFO]`、`[DEBUG]` 这类日志保持非结构化。单引号、缺少分隔符、键值之间漏冒号都能识别，而 `messageCount` 这样的前缀不算协议键。识别出的畸形协议输出会阻断该操作。
- **其余内容** —— 没有可识别协议键的畸形文本，例如引用了 "message" 字样的日志行 —— 无法与普通日志区分，保持非结构化并放行。

也可以通过标准输出返回一段 JSON 来阻断：

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "请用 rg 代替 grep"
  }
}
```

::: info 哪些事件可以阻断？
只有 `PreToolUse`、`Stop` 和 `UserPromptSubmit` 的返回值会影响主流程。其余都是观察型事件，触发后不管脚本返回什么都不改变主流程。
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

阻断后，Kiki 会把原因写回上下文，模型可以据此选择更安全的做法。

::: warning 注意
这个示例只演示阻断机制，按子串匹配不是安全解析器。真正要做防护，请用白名单列出允许的命令，或使用能处理引号、变量展开和命令串联的 Shell 解析器。
:::

## 下一步

- [Legacy 规则字段](#legacy-规则字段) — `[[hooks]]` 的完整字段说明
- [Agent 与 subagent](./agents.md) — 用 `SubagentStop` 事件在 subagent 完成后触发通知
