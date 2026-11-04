# Argon Error Recovery (Unofficial) / Argon 错误恢复（非官方）

这是一个独立、非官方的插件，与 Kiki 或 Argon 维护者无关联。

This is an independent, unofficial plugin. It is not affiliated with the Kiki or Argon maintainers.

## 宿主前提 / Host requirement

宿主必须提供 `StopFailure` 的显式 recovery 接口；安装版原协议不支持该接口。

The host must expose an explicit recovery interface for `StopFailure`; the original installed protocol does not provide it.

## 唯一自动恢复 / Only automatic recovery

仅首次同时满足以下条件时，插件才输出指定结果：

- `hook_event_name` 为 `StopFailure`
- `upstream_error_code` 为 `antigravity_missing_terminal`
- `recoverable` 为 `true`
- `recovery_attempts` 为 `0`

```js
{ hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } }
```

这保证每回合至多恢复一次。插件只读取结构化错误码，不从错误文字猜码，也不重放旧请求或工具。

The plugin returns the object above only when all four conditions match. The `recovery_attempts: 0` gate allows at most one recovery per round. It uses structured error codes only: it never guesses from error text and never replays an old request or tool call.

## 其它实际错误码 / Other actual error codes

| 代码 / Code | 处理 / Handling |
| --- | --- |
| `thinking_only` (`antigravity_thinking_only`) | 原生一次续接 / One native continuation |
| `empty_response` (`antigravity_empty_response`) | 原生重试 / Native retry |
| `max_tokens` (`antigravity_max_tokens`) | 用户明确决定继续或调整输出预算 / The user must explicitly choose whether to continue or adjust the output budget |
| `stream_read_error` (`antigravity_stream_read_error`) | 由原生网络恢复；结果未知时不新发 / Native network recovery; do not send a new request when the result is unknown |
| `safety`, `malformed_function_call`, `malformed_response`, `upstream_terminal_error` | 不自动恢复，检查上游与请求 / No automatic recovery; inspect the upstream and request |
| 凭据、配额、计费、取消 / Credentials, quota, billing, cancellation | 不恢复 / No recovery |

## 安装与测试 / Install and test

```text
/plugins install --trust ./argon-error-recovery
/plugins enable argon-error-recovery
```

源码修改后，从同一 `./argon-error-recovery` 来源重新安装。修改后的源码包可独立运行以下测试，且无第三方依赖：

After changing the source, reinstall from the same `./argon-error-recovery` source. The source package can run these tests independently and has no third-party dependencies:

```sh
node --test test/*.test.mjs
```
