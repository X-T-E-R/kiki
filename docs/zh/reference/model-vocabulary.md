---
title: 模型选择词汇
description: 模型 alias、wire 标识与 subagent 绑定规则的统一参考。
outline: [2, 3]
---

# 模型选择词汇

Kiki 的模型选择把三件事分开：配置文件里的模型键、派发 subagent 时使用的 `model_alias`，以及实际发给供应商的模型标识。本页统一解释这套词汇和绑定规则，主要在你为 subagent 或 profile 指定模型时用到。

## 当前词汇

- **已配置模型键**：`config.toml` 的 `[models]` 中某个条目的 key。解析结果以它作为规范运行时标识。
- **`model_alias`**：`AgentRun` 调用、Agent 文件、profile route 使用的模型选择器，取值就是某个已配置模型键。
- **Wire 模型标识**：实际发送给供应商接口的 `model` 值；它不必与已配置模型键相同，比如同一个供应商模型可以在配置里登记成多个不同用途的键。
- **Thinking effort**：思考强度。派发参数 `effort`，或 profile / route 的 `thinking_effort`，与 `model_alias` 独立解析。

## 绑定规则

新派生 subagent 的模型只有两个来源：

1. 派发时传入的 `model_alias`。
2. 生效 profile、route 或调用方 lease（caller lease，外部委派方为调用方预设的约束）上的 `model_alias` pin。

两者都存在时以派发值为准。两者都没有时，派生以 `model.not_configured` 失败；subagent 不会继承调用方模型，也不会回退到某个默认模型。未知 alias 与被机器级策略禁止的模型会在子 Agent 启动前失败。若模型只是不符合 role 指引，或偏离 route / caller lease pin，只要实际可执行就会继续，并产生结构化绑定 advisory。

恢复或重试的 subagent 会保持已持久化的绑定，除非 `AgentRun` 的 `resume` 显式请求修改。省略 `effort` 会保留当前值；显式传入的 effort 应用于下一次空闲运行。显式传入的 `model_alias` 只有在 `allow_model_change: true` 确认时才能切换模型；如果解析到同一规范模型，则不产生变化。

## Agent 文件与 routes

Agent 文件与 profile route sidecar 使用 `model_alias` 固定模型。旧字段 `model_preference` 会被显式拒绝，并给出迁移诊断；其他工具写入的未知 `model` 元数据会被忽略。

Route 声明的 `model_alias` 是 route 默认值。派发方可以用另一个可执行模型覆盖它；绑定仍保留 route 身份，同时标记为 detached 并携带 advisory。Role 级 `allowed_models` / `deny_models` 与 effort 列表属于推荐策略；机器级 `[subagent].deny_models` 才是硬模型边界。

## 模型 ID 解析

Kiki 按以下顺序把请求值解析为规范已配置 key：

1. 精确命中的已配置 key 优先。
2. 接受模型记录显式声明的 alias；有歧义时失败。
3. 不带限定前缀的值可以匹配已配置 key 的最后一段，或模型记录中 wire `model` 值的最后一段；有歧义时失败。
4. 带限定前缀的值只有在 provider 前缀与目标记录一致时，才能通过已配置的尾部 key 解析。
5. 未知或不完整的值不会解析成功。

这种便利解析不会形成另一套选择词汇：公开 subagent 表面仍只暴露 `model_alias`。

## 下一步

- [Agent 与 subagent](../customization/agents.md#agent-文件格式) — Agent 文件字段与 subagent 绑定行为。
- [配置文件](../configuration/config-files.md#subagent) — 模型注册表与 subagent 配置。
