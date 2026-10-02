# Hooks 制作参考

版本匹配的完整文档在服务器主机的 `<KIKI_HOME>/docs/zh/customization/hooks.md`（未设置 KIKI_HOME 时为 `~/.kiki`）。先读该文档，再扩展下面的最小示例。

## 声明式 v2 A：指导与观察

用户级规则写在 `<KIKI_HOME>/config.toml`，项目级规则写在已信任项目的 `.kiki/hooks.toml`；插件规则来自已启用插件。项目规则不必升级成用户全局规则。先读取现有配置，不覆盖已有条目。

每完成三步，只提醒主智能体：

```toml
[hooks]
schema_version = 2

[[hooks.rules]]
id = "evidence-check"
event = "step.before"

[hooks.rules.match]
agent_roles = ["root"]
executors = ["native"]

[hooks.rules.cadence]
every_completed_steps = 3
counter_scope = "agent"
partition_by = "model"

[hooks.rules.action]
type = "inject"
text = "继续前核对已有证据，指出还需验证的一项。"
```

一步是一次模型响应及全部工具结果落定并提交，不是一次工具调用或重试。此例完成三步后在下一次模型请求前提醒；没有下一次请求时不额外开轮次。计数按各 Agent、模型配置身份分别维护。要在每轮清零才用 `counter_scope = "turn"`，不自行模拟计数器。

观察工具错误，不改变原操作：

```toml
[hooks]
schema_version = 2

[[hooks.rules]]
id = "observe-tool-error"
event = "tool.after"

[hooks.rules.match]
statuses = ["error"]

[hooks.rules.action]
type = "observe"
```

这两个示例是独立文件；合并时只保留一个 `[hooks]`，追加各自的规则。

- `inject` 只用于 `step.before` 或 `prompt.submit`；`observe` 支持这两个事件，以及 `step.after`、`tool.before`、`tool.after`、`turn.stopping`、`turn.after`、`session.start`。节拍只用于 step 事件。
- `prompt.submit` 默认仅匹配用户来源；确实需要任务、邮件或插话来源时才添加 `match.sources`。其他匹配字段使用精确值，字段之间同时满足，同一字段内任一值命中即可。限制模型、profile 或 route 时先确认本机实际绑定，模型别名不得凭空编造。
- 用户、项目、插件的规则叠加执行；同一来源不要重复 ID。小的 priority 先执行，没有「模型规则覆盖 profile 规则」的替换关系。
- `text_file` 与 `text` 二选一；`files` 可包含其他 v2 文件。当前 loader 只收相对路径，以声明文件为起点，真实路径仍须留在来源范围内；绝对路径、目录外共享文件或符号链接逃逸不能加载。这是当前版本限制，已规划的自由路径支持尚未落地，不绕过检查。
- 注入文本连同包装后的 UTF-8 总大小须在 8 KiB 内，指导不替换系统提示。超限或空文本按诊断缩短，不拆成大量规则绕开限额。

### 检查有效规则

`hooks-inspect` 是引擎命令，不是一个新 CLI 子命令。通过可用的原生客户端命令入口调用；已有 klient 实例时：

```ts
await klient.session(sessionId).agent("main").runCommand({ name: "hooks-inspect" });
```

从客户端诊断事件读取结果。检查规则来源、active / reason、binding、completedSteps、nextDue；项目未信任、重复 ID、拼错模型或外部执行器不支持 step/tool 事件时，根据诊断处理。检查视图不是模型对话消息，不要等待它自己出现在聊天里。

本地验证样例：指导规则的 native/root 在完成 0、1、2 步时不提醒，完成 3 步后的下一次请求才提醒；相同条件的 subagent 不命中。观察规则在工具返回 error 时命中，success 时不命中。先查看绑定与计数，再跑到目标事件，查看注入披露或观察事件记录，并再次检查计数，不把「active」当成已触发。

## Legacy command：执行脚本

脚本仍使用旧协议。已有 `[[hooks]]` 数组可以保持原样；与 v2 共存时移至 `[[hooks.legacy]]`，不要在同一个 TOML 文件里同时声明 `[[hooks]]` 和 `[hooks]`，也不要自动改变旧脚本语义。

以下示例仅验证任务完成事件的脚本输入输出，不发送桌面通知。先确认本机有 Node，或改用用户已有运行环境：

```toml
[hooks]
schema_version = 2

[[hooks.legacy]]
event = "Notification"
matcher = '^task\.completed$'
command = "node .kiki/hooks/task-event.mjs"
timeout = 5
```

脚本位置相对于会话工作目录；路径含空格时按本机 Shell 引号规则处理。脚本读取 stdin JSON，例如：

```js
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.hook_event_name === 'Notification') {
  console.log(JSON.stringify({ message: '已收到任务完成事件。' }));
}
```

本地输入 fixture：

```json
{"hook_event_name":"Notification","session_id":"fixture-session","cwd":"."}
```

用 fixture 向脚本的 stdin 输入 JSON，预期退出 0 且 stdout 为该 message 对象；将事件改成 SessionStart 时无输出。运行期间以实际输出和退出状态为准；真正通知、写文件或外部发送按用户任务实现，不在这份示例中暗中加入。

legacy 事件名大小写与 v2 不同，matcher 是正则，timeout 单位为秒。退出 0 表示放行，可附带文本或合法响应 JSON；退出 2 表示主动阻断。`PreToolUse`、`Stop`、`UserPromptSubmit` 可阻断，失败或超时会停止原操作；其余观察事件不阻断。完整输入字段及响应格式回到安装文档核对。原生 `hooks-inspect` 检查 v2 规则，旧脚本还须检查 hook 执行结果与目标事件的真实效果。

## 未来 v2 B

新版脚本动作与一次安装/启用知情同意已规划，但尚未实现。当前不要写 v2 的 command、gate、block、continue；需要脚本就选 legacy，不另设逐次审批或自造沙箱。能力落地后以安装版本的原生契约更新此分支。
