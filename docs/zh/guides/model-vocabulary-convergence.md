---
title: 模型词汇收敛路线
description: agent-core-v2 当前的模型选择词汇与绑定规则。
outline: [2, 3]
---

# 模型词汇收敛路线

Kiki 只使用 `packages/agent-core-v2` 作为 Agent 引擎。模型选择现在统一使用显式的派发与 profile 字段 `model_alias`，thinking effort 继续作为独立设置。

::: info 变更
此前的收敛路线已经完成。`model` 派发参数、`model_preference` Frontmatter 字段与 `[secondary_model]` 配置节不再属于当前契约。
:::

## 当前词汇

当前词汇把配置身份、provider 身份与 thinking effort 分开：

- **已配置模型键**：`[models]` 中某个条目的 key。解析结果以它作为规范运行时标识。
- **`model_alias`**：`AgentRun`、Agent 文件、profile route 与 caller lease 使用的已配置模型选择器。
- **Wire 模型标识**：模型记录内部、实际发送给 provider endpoint 的 `model` 值；它不必与已配置模型键相同。
- **Thinking effort**：派发参数 `effort`，或 profile / route 的 `thinking_effort`。它与 `model_alias` 独立解析。

## 绑定规则

新派生 subagent 的模型只有两个来源：

1. 派发时传入的 `model_alias`。
2. 生效 profile、route 或 caller lease 上的 `model_alias` pin。

两者都存在时以派发值为准。两者都没有时，派生以 `model.not_configured` 失败；subagent 不会继承调用方模型，也不会回退到已配置默认模型。未知 alias、被机器级或 role 约束拒绝的模型，同样会在子 Agent 启动前失败。

恢复或重试的 subagent 会保持已持久化的绑定，除非 `AgentRun` 的 `resume` 显式请求修改。省略 `effort` 会保留当前值；显式传入的 effort 应用于下一次空闲运行。显式传入的 `model_alias` 只有在 `allow_model_change: true` 确认时才能切换模型；如果解析到同一规范模型，则不产生变化。调用方、role、route 与 executor 限制（包括机器级和 role 级模型约束）仍会强制执行。外部 executor 不支持修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。

## Agent 文件与 routes

Agent 文件与 profile route sidecar 使用 `model_alias` 固定模型。`model_preference` 会被显式拒绝，并给出迁移诊断。普通 Agent 文件继续忽略其他工具写入的未知 `model` 元数据；route sidecar 保持严格解析并拒绝未知字段。

Route 声明的 `model_alias` 对自动派发锁定。`AgentRun` 可以省略它，或重复同一个解析后模型；冲突值会被拒绝。Role 级 `allowed_models`、`deny_models` 与机器级 `[subagent].deny_models` 只能继续收紧允许集合。

## 模型 ID 解析

`ModelService.resolveId` 按以下顺序把请求值解析为规范已配置 key：

1. 精确命中的已配置 key 优先。
2. 接受模型记录显式声明的 alias；有歧义时失败。
3. 不带限定前缀的值可以匹配已配置 key 的最后一段，或模型记录中 wire `model` 值的最后一段；有歧义时失败。
4. 带限定前缀的值只有在 provider 前缀与目标记录一致时，才能通过已配置的尾部 key 解析。
5. 未知或不完整的值不会解析成功。

这种便利解析不会形成另一套选择词汇：公开 subagent 表面仍只暴露 `model_alias`。

## 源码索引

当前行为由以下仓库路径支撑：

- **已配置 key 解析**：`packages/agent-core-v2/src/kosong/model/resolveModelId.ts`
- **派发 schema**：`packages/agent-core-v2/src/agent/tools/agent/agent.ts`
- **subagent 绑定**：`packages/agent-core-v2/src/session/subagent/configSection.ts`
- **Agent 文件解析**：`packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentFile.ts`
- **profile route 解析**：`packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRouteFile.ts`

## 下一步

- [Agent 与 subagent](../customization/agents.md#agent-文件格式) — 当前 Agent 文件字段与 subagent 绑定行为。
- [配置文件](../configuration/config-files.md#subagent) — 当前模型注册表与 subagent 配置。
- [Kiki 运行时边界](./kiki-runtime.md) — 单一 Agent 引擎的责任边界。
