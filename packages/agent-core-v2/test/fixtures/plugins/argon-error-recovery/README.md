# Argon Error Recovery (Unofficial) / Argon 错误恢复（非官方）

Argon 请求断流时，自动追加一次可见的用户消息 "继续"。保留最后的部分回答与已完成工具结果，不重放旧请求或工具。这是独立的非官方插件，与 Kiki 或 Argon 维护者无关联。

Automatically append one visible user message, "继续", after an Argon stream interruption. The last partial answer and completed tool results remain in context; old requests and tools are not replayed. This independent, unofficial plugin is not affiliated with the Kiki or Argon maintainers.

## 安装与更新 / Install and update

需要支持 `StopFailure` recovery 的 Kiki 宿主，以及 `PATH` 中可运行的 Node.js 24 或更高版本。插件没有第三方依赖，无需 `npm install`。

Use a Kiki host that supports `StopFailure` recovery and has Node.js 24 or later on `PATH`. The plugin has no third-party dependencies and needs no `npm install`.

```text
/plugins install --trust ./argon-error-recovery
/plugins enable argon-error-recovery
```

更新时，替换原来源目录的内容，再从同一路径执行 `/plugins install ./argon-error-recovery`，沿用已有的同意和启用状态。`/plugins reload` 不会复制来源目录的改动。可用 `/plugins disable argon-error-recovery` 关闭自动接续。

To update, replace the original source directory's contents and repeat `/plugins install ./argon-error-recovery` from the same source path. This retains its consent and enabled state. `/plugins reload` does not copy source edits. Use `/plugins disable argon-error-recovery` to turn off automatic continuation.

## 恢复范围 / Recovery scope

仅处理 `hook_event_name: "StopFailure"`、`recoverable: true` 且 `recovery_attempts: 0` 的事件。命中以下任一项时，输出同一个接续动作：

The plugin handles only `StopFailure` events with `recoverable: true` and `recovery_attempts: 0`. Any matching row requests the same continuation:

| 结构化失败 / Structured failure | 模型范围 / Model scope |
| --- | --- |
| `upstream_error_code: "antigravity_missing_terminal"` | 保留 0.1.0 行为；旧宿主无需提供模型字段 / Preserves 0.1.0 behavior; older hosts need no model field |
| `upstream_error_code: "gateway_stream_terminal_error"` | 宿主 `model_alias` 精确为 `axon-message/gemini-4-argon` / Host `model_alias` must equal `axon-message/gemini-4-argon` |
| `error_code: "provider.connection_error"` 且 / with `error_details.retry_exhausted: true` | 同一 Argon 别名；先完成原生请求重试 / Same Argon alias; native request retries run first |

```json
{"hookSpecificOutput":{"recovery":{"action":"continue","userMessage":"继续"}}}
```

每轮最多接续一次，重复失败即停止；下一轮恢复预算重新开始。新增范围需要宿主提供 `model_alias`，并把网关流终止的同请求重发禁令与新消息接续分开判断；没有模型字段时不扩大旧行为。不从 profile 名或错误文字猜模型、错误码。原生模型请求是否已送达或执行不明，不是追加新消息的阻断条件。

Continuation is limited to once per turn; a repeated failure stops, and the next turn starts with a fresh budget. The new cases require a host-supplied `model_alias` and a host that distinguishes a gateway stream's same-request retry denial from new-message continuation. Without the model field, only the original behavior applies. The plugin does not infer a model or code from profile names or error text. Uncertain delivery or execution of a native model request does not block the new message.

`thinking_only` 继续由原生机制处理。插件不匹配未分类的 `antigravity_empty_response`、`antigravity_stream_read_error`、`antigravity_max_tokens`，也不接管外部执行器的恢复。取消、认证、计费、配额、过滤、无效配置及普通 429 仍按宿主处理，不追加消息。

Native recovery still owns `thinking_only`. The plugin does not match unclassified `antigravity_empty_response`, `antigravity_stream_read_error`, or `antigravity_max_tokens`, or take over external-executor recovery. Cancellation, authentication, billing, quota, filtering, invalid configuration, and ordinary 429 failures retain their host handling without an appended message.

## 测试 / Test

在插件目录运行，覆盖一次接续、模型范围、旧宿主行为和真实脚本输入输出：

Run in the plugin directory to check the one-continuation limit, model scope, older-host behavior, and actual script input/output:

```sh
node --test test/*.test.mjs
```
