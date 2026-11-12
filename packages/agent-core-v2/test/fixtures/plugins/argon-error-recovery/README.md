# Argon Error Recovery (Unofficial) / Argon 错误恢复（非官方）

仅对命中的 Argon `StopFailure` 事件恢复：`has_partial_output === true` 时，追加可见的用户消息“继续”，从保留的输出接续；为 `false` 或缺失时，在原失败步骤内重试，不添加新消息。该插件独立维护，与 Kiki 或 Argon 维护者无关联。

On a matched Argon `StopFailure`, the plugin continues with the visible user message `继续` only when `has_partial_output === true`. When the field is false or absent, it retries in place without adding a message. This independent, unofficial plugin is not affiliated with the Kiki or Argon maintainers.

## 安装与更新 / Install and update

需要支持 `StopFailure` 的 `retry` 动作和 `has_partial_output` 字段的 Kiki 宿主，以及 `PATH` 中可运行的 Node.js 24 或更高版本。插件没有第三方依赖，无需 `npm install`。

Use a Kiki host that supports the `StopFailure` `retry` action and `has_partial_output` field, with Node.js 24 or later on `PATH`. The plugin has no third-party dependencies and needs no `npm install`.

```text
/plugins install --trust ./argon-error-recovery
/plugins enable argon-error-recovery
```

更新时，替换原来源目录的内容，再从同一路径执行 `/plugins install ./argon-error-recovery`，沿用已有的同意和启用状态。`/plugins reload` 不会复制来源目录的改动。可用 `/plugins disable argon-error-recovery` 关闭自动恢复。

To update, replace the original source directory's contents and repeat `/plugins install ./argon-error-recovery` from the same source path. This retains its consent and enabled state. `/plugins reload` does not copy source edits. Use `/plugins disable argon-error-recovery` to turn off automatic recovery.

## 恢复范围 / Recovery scope

仅处理 `hook_event_name: "StopFailure"`、`recoverable: true` 且 `recovery_attempts: 0` 的事件。命中下表任一结构化失败后，再根据 `has_partial_output` 选择接续或原位重试：

The plugin handles only `StopFailure` events with `recoverable: true` and `recovery_attempts: 0`. A matching structured failure uses `has_partial_output` to choose continuation or an in-place retry:

| 结构化失败 / Structured failure | 模型范围 / Model scope |
| --- | --- |
| `upstream_error_code: "antigravity_missing_terminal"`（或上游省略 `code` 时 `error_message` 以 `Anthropic error: antigravity_missing_terminal:` 开头 / or `error_message` prefixed by `Anthropic error: antigravity_missing_terminal:` when upstream omits `code`） | 旧宿主无需提供模型字段 / Older hosts need no model field |
| `upstream_error_code: "gateway_stream_terminal_error"` | 宿主 `model_alias` 为 `axon-message/gemini-4-carbon` 或 `axon-message/gemini-4-argon` / Host `model_alias` must equal `axon-message/gemini-4-carbon` or `axon-message/gemini-4-argon` |
| `error_code: "provider.connection_error"` 且 / with `error_details.retry_exhausted: true` | 同一 Argon 别名；先完成原生请求重试 / Same Argon alias; native request retries run first |

保留了部分实质回答、媒体或工具调用结果时，输出接续动作：

When substantive answer content, media, or tool calls were retained, the hook requests continuation:

```json
{"hookSpecificOutput":{"recovery":{"action":"continue","userMessage":"继续"}}}
```

`has_partial_output` 为 `false` 或缺失时，输出 `retry`，不带 `userMessage`，让宿主在原失败步骤内重试：

When `has_partial_output` is false or absent, the hook requests `retry` without a `userMessage`, so the host retries the failed step in place:

```json
{"hookSpecificOutput":{"recovery":{"action":"retry"}}}
```

每个连续失败段最多恢复一次，原位重试和追加消息接续共用这一预算；紧接着再次失败即停止。完成一次含有效正文或模型工具调用的完整模型响应后，宿主重置预算，同一轮后续新的失败段可再次恢复。宿主先执行原生重试，再按 `recoverable` 准入 hook 恢复；插件不从 profile 名或错误文字猜模型、错误码。

Each failure streak permits one recovery action, shared by in-place retries and message-based continuations. An immediate repeat failure stops. A complete model response with usable content or model tool calls resets the budget for later failure streaks in the same turn. Native request retries run first, and the host admits hook recovery through `recoverable`. The plugin does not infer models or codes from profile names or error text.

`thinking_only` 继续由原生机制处理。插件不匹配未分类的 `antigravity_empty_response`、`antigravity_stream_read_error`、`antigravity_max_tokens`，也不接管外部执行器的恢复。取消、认证、计费、配额、过滤、无效配置及普通 429 仍按宿主处理，不触发插件恢复。

Native recovery still owns `thinking_only`. The plugin does not match unclassified `antigravity_empty_response`, `antigravity_stream_read_error`, or `antigravity_max_tokens`, or take over external-executor recovery. Cancellation, authentication, billing, quota, filtering, invalid configuration, and ordinary 429 failures retain their host handling without plugin recovery.

## 测试 / Test

在插件目录运行，覆盖错误码、模型范围、接续与原位重试，以及脚本的真实 stdin/stdout：

Run in the plugin directory to check error codes, model scope, continuation and in-place retry, and the script's real stdin/stdout behavior:

```sh
node --test test/recovery.test.mjs
```
