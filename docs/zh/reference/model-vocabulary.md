---
title: 模型选择词汇
description: 模型 alias、wire 标识与 subagent 绑定规则的统一参考。
outline: [2, 3]
---

# 模型选择词汇

Kiki 的模型选择把三件事分开：配置文件里的模型键、派发 subagent 时使用的 `model_alias`，以及实际发给供应商的模型标识。本页统一解释这套词汇和绑定规则，主要在你为 subagent 或 profile 指定模型时用到。

## 当前词汇

- **已配置模型键**：`config.toml` 的 `[models]` 中某个条目的 key。解析结果以它作为规范运行时标识。
- **`model_alias`**：`AgentRun` 调用、Agent 文件、profile route 使用的模型选择器。`AgentRun` 接受具体的已配置模型名或 `auto`；只有 subagent profile、route 和 caller lease 可以写 `inherit`。
- **Wire 模型标识**：实际发送给供应商接口的 `model` 值；它不必与已配置模型键相同，比如同一个供应商模型可以在配置里登记成多个不同用途的键。
- **Thinking effort**：思考强度。派发参数 `effort`，或 profile / route 的 `thinking_effort`，通常与 `model_alias` 独立解析；显式继承模型时也跟随调用方有效思考强度，除非有适用的 effort pin。

## 绑定规则

新建子 Agent 时，显式传入的具体 alias 优先。否则先读目标 profile 的 `model_selection`，再读全局 `[subagent].model_selection`。默认静态选模：先用生效的 profile、route 或 caller lease 上的模型 pin，再用显式配置的 `[subagent].default_model`。普通职责缺少静态绑定时以 `model.not_configured` 失败；[裸引擎目标](../customization/agents-and-subagents.md#具名子-agent)可使用厂商默认模型。

`model_alias: "auto"` 显式请求[自动选模](../configuration/config-files.md#自动选模)，不受默认选模方式影响。Kiki 在合格候选中选择一次，保存具体模型和思考强度。`AgentRun` 本身拒绝 `model_alias: "inherit"`；两种受支持的选模方式都受模型与档位硬限制约束。要跟随调用方，在 profile、route 或 caller lease 中写 `model_alias: inherit` 并使用静态选模；显式 `effort` 或适用的档位 pin 优先于调用方的思考强度。

`AgentSend` 和省略 `model_alias` 的 `resume` 沿用已保存的模型。`resume` 可显式指定具体 alias 或再次传 `auto`。只有选中不同规范模型时，才需要用 [`context_mode`](../customization/agents-and-subagents.md#具名子-agent) 或旧参数确认换模。不论是否换模，显式传入的档位都可用于下一次空闲运行。

## Agent 文件与 routes

Agent 文件与 profile route sidecar 使用 `model_alias` 固定模型；main agent 没有调用方，其 profile 不可使用 `inherit`。旧字段 `model_preference` 会被拒绝并给出迁移提示，其他工具留下的未知 `model` 元数据同样会加载失败——请删掉不支持的字段，不要指望它们被忽略。

Route 声明的 `model_alias` 是软默认值；`preferred_models`、`discouraged_models`、`preferred_efforts` 是建议。`allowed_models`、`deny_models`、`allowed_efforts` 是硬限制：在 subagent 中越界会拒绝绑定、人工切换或恢复；在主会话中以你的选择为准，越界只警示。`[subagent].deny_models` 是另一道硬限制。原生模型列表比较规范身份，外部 executor 比较它实际调用的生效模型 ID。

## 按身份区分的设置

一个模型带一套共用设置：默认思考档位、服务档位、自动压缩触发点、上下文使用预算与最大生成 token。某个身份可以覆盖其中少数几项，且只覆盖这几项——未填的字段继续使用共用值，所以覆盖是差异，而不是把设置复制第二份。

- **共用**：模型自身的值。该模型的每次使用都从这里开始，sub 始终使用共用值。
- **主智能体**：模型作为主智能体时生效，与当前由哪个 profile 持有无关。未填的字段继续继承。
- **外部委派智能体**：外部宿主委派进来的智能体。未填的字段继续继承。

身份说的是模型在为谁服务，而不是选了哪个 profile，所以切换 profile 不会丢掉这一层。覆盖提示词或认知字段是另一套机制：它们整组替换，而这里的设置逐字段修改。清空某个覆盖即恢复共用值。`usage_effective` 与 `usage_sources` 报告各身份实际解析到的值及其来源；它们描述模型自身的解析结果，不包含 profile pin 或会话覆盖。

上下文使用预算与最大生成 token 是上限而非偏好：生效值取共用上限与身份值中的较小者，因此身份只能收紧，不能放宽到超出模型允许的范围。

在 [**设置 → 模型与智能体 → 模型 → 连接**](../guides/settings.md#连接)中，展开连接，打开模型列表并点击模型行，在侧面板打开模型编辑器。编辑器默认展示共用值；切到主智能体只看并编辑该身份的差异，编辑器会显示每个字段继承自哪里、最终生效值是多少。

## 模型 ID 解析

Kiki 按以下顺序把请求值解析为规范已配置 key：

1. 精确命中的已配置 key 优先。
2. 接受模型记录显式声明的 alias；有歧义时失败。
3. 不带限定前缀的值可以匹配已配置 key 的最后一段，或模型记录中 wire `model` 值的最后一段；有歧义时失败。
4. 带限定前缀的值只有在 provider 前缀与目标记录一致时，才能通过已配置的尾部 key 解析。
5. 未知或不完整的值不会解析成功。

这种便利解析不会形成另一套选择词汇：公开 subagent 表面仍只暴露 `model_alias`。

## 下一步

- [Agent 与 subagent](../customization/agents-and-subagents.md#agent-文件格式) — Agent 文件字段与 subagent 绑定行为。
- [配置文件](../configuration/config-files.md#subagent) — 模型注册表与 subagent 配置。
