---
title: 模型词汇收敛路线
description: agent-core 与 agent-core-v2 当前的模型选择词汇、推荐目标态及分阶段兼容路线。
outline: [2, 3]
---

# 模型词汇收敛路线

Kiki 当前在旧版 `agent-core` 引擎、`agent-core-v2` 委派契约和 Agent 文件 Frontmatter 中，用不同字段名表达相近的模型选择概念。本路线说明这些词汇的边界、推荐目标态与迁移阶段；它本身不实施或排期任何迁移。

::: warning 注意
本文是设计路线，不是弃用通知。在另行评审的实现真正修改行为前，现有配置、Agent 文件、工具调用和已持久化的子 Agent 绑定都保持当前语义。
:::

::: danger 内容已过期
本文写于双引擎并存时期。`packages/agent-core`（v1）此后已被删除，因此下文所有描述 v1 词汇的条目与源码路径都属于历史，而非当前行为。收敛目标本身仍然成立；本文已排入重基线队列。
:::

## 先区分概念

把下面三类概念分开后，当前词汇会更容易理解：

- **已配置模型键**：`[models]` 中某个条目的 key，解析后作为运行时规范标识。
- **符号或模型池选择**：例如 `primary`、`secondary` 或已配置的子 Agent 模型池 key。它描述「如何选择模型」，而不是直接命名模型记录。
- **Wire 模型标识**：模型记录内部、实际发送给 provider endpoint 的模型名称；它不一定等于已配置模型键。

`model_alias` 是显式选择已配置模型的路径。`model` 与 `model_preference` 属于选择词汇，其精确语义由各自所在的表面决定。

## 当前状态

三种写法并存，是因为它们属于兼容历史不同的契约。

| 表面 | 字段 | 当前语义 | 存在理由 |
| --- | --- | --- | --- |
| 旧版 `packages/agent-core` profile 与 Agent 文件 | `model_preference`、`model_alias` | `model_preference` 只接受 `primary` 或 `secondary`；`model_alias` 指向已配置模型。两者互斥，进入运行时后成为内部 `modelPreference` / `modelAlias` profile 字段。 | v1 profile 与 Agent 文件格式早于 v2 委派词汇，且可选的旧版引擎仍需要它。 |
| `packages/agent-core-v2` 的 `AgentRun` / `AgentSwarm` 委派 | `model`、`model_alias` | `model` 是符号或已配置模型池选择器。`primary` 固定继承调用方绑定，其他可接受值来自已配置的子 Agent 模型池；`model_alias` 直接选择已配置模型。两者互斥。 | 这是当前面向模型的 v2 委派契约，可向工具暴露有界模型池，而不必把所有已配置模型都当作符号选项。 |
| v2 中的 Kiki Agent 文件与 profile route sidecar | `model_preference`、`model_alias` | `model_preference` 仍只接受 `primary` 或 `secondary`，解析时映射到 profile 的内部选择字段；`secondary` 表示已配置模型池的默认模型。`model_alias` 仍是直接选择已配置模型的字段。 | Kiki 在同步上游时保留了 Agent 文件特性。该写法属于持久化、由用户编写的 schema，不是 v2 工具参数。 |

普通 Agent 文件会有意忽略未知 Frontmatter 字段，包括其他工具使用的 `model` 字段；profile route sidecar 使用严格解析，会拒绝未知字段。因此，把 Agent 文件字段改名为 `model` 不只是改拼写，还会同时改变兼容行为和报错行为。

### 模型 ID 解析

v1 的 `resolveModelAlias` 与 v2 的 `ModelService.resolveId` 都遵循同一组重要规则：

1. 精确命中的已配置 key 优先。
2. 请求中包含 `/` 且没有精确命中时，不做后缀匹配。
3. 不带限定前缀的值，可以匹配已配置 key 的最后一段，或模型记录中 `model` 值的最后一段。
4. 只有一个候选时解析为其规范已配置 key；有多个候选时失败，并要求使用完整 ID。

这种 bare ID 便利解析属于解析规则，不是第四套选择词汇。收敛工作不能把它变成 `model` 的另一种公开含义。

## 推荐目标态

推荐目标是统一 v2 委派语义，同时把 Agent 文件兼容性限制在 schema 边界。

| 边界 | 目标词汇 | 目标规则 |
| --- | --- | --- |
| 面向模型的 v2 委派工具 | `model`、`model_alias` | `model` 保持为有界符号 / 模型池选择器；`model_alias` 保持为直接选择已配置模型的选择器。 |
| 输入解析后的 v2 运行时 | 一种规范化选择表示 | 工具 `model` 与 Agent 文件 `model_preference` 在进入优先级与校验逻辑前，映射到同一个内部选择概念；schema 拼写不继续泄漏到下游解析逻辑。 |
| Agent 文件与 route Frontmatter | 保留 `model_preference`、`model_alias` | 把 `model_preference` 视为 Agent 文件 schema 的兼容词汇，而不是 v2 运行时 API 的另一套命名。 |
| 模型注册表 | 规范已配置模型 key | 解析结果返回已配置 key；bare ID 匹配继续作为便利能力，并保留精确命中和歧义保护。 |
| v1 引擎 | 仅兼容词汇 | v1 仍受支持时保持当前行为；不要只为让字段名看起来像 v2 而重新设计 v1。 |

### 为什么 Agent 文件应保留 `model_preference`

与静默把 Agent 文件收敛到 `model` 相比，保留 `model_preference` 更合适：

- Agent 文件是持久化、由用户编写的文档，会跨版本使用，有时还会跨 Agent 工具共享。
- `model_preference` 明确表示符号化的 `primary` / `secondary` 行为；`model_alias` 仍可寻址字面值名为 `primary` 或 `secondary` 的 alias。
- 现有普通 Agent 文件会为兼容其他工具而忽略未知 `model` 字段。重新解释该字段，可能让原本无行为的文件意外改变模型选择。
- 上游 v2 不再需要让 `model_preference` 贯穿运行时。只在 Kiki 的解析与序列化边界保留该拼写，可以把 fork 特有差异限制在较小范围。

未来如确需改名，应通过带版本的 Agent 文件 schema 和明确兼容规则完成，不能夹带在普通引擎清理中。

## 迁移阶段

下面的阶段先让语义可测量，再考虑名称或持久化格式变化。

### 阶段 0：文档化并冻结语义

记录当前字段、允许值、优先级、feature flag 行为与解析规则。在此阶段，不新增同义词，也不把 `model` 扩展成既表示模型池选择、又任意表示已配置 alias 的混合字段。

**退出条件：** v1 profile 契约、v2 工具契约、Agent 文件 schema 和模型注册表解析均有明确责任边界与测试矩阵。

### 阶段 1：在 v2 输入边界规范化

定义一种内部选择结构，明确区分符号 / 模型池选择与已配置模型选择。`AgentRun` / `AgentSwarm` 的 `model`、Agent 文件的 `model_preference` 和 `model_alias` 都先转换为该结构，再进入优先级计算。

本阶段可以重命名内部 TypeScript 属性，但不得改变工具 schema、Frontmatter、配置文件、journal 数据或运行结果。

**退出条件：** 优先级与校验逻辑只依赖规范化语义，不再按各 schema 的字段名分支。

### 阶段 2：把 v2 作为规范行为参考

集中定义 `model` 与 `model_alias` 的预期行为：互斥、模型池校验、`primary` 行为、Agent 文件 `secondary` 行为、直接已配置模型解析、thinking effort 独立解析，以及显式非法选择的报错。

v1 可在合适时共享测试或 fixture，但它是兼容消费者，不再成为新词汇的来源。

**退出条件：** 等价的 v1 与 v2 输入，要么有已记录的等价行为，要么有已记录的有意差异。

### 阶段 3：隔离兼容适配器

把 Agent 文件 `model_preference` 解析和所有持久化旧拼写限制在窄适配层。新的 v2 domain 只消费规范化选择数据，不应在 profile 加载与兼容层之外继续增加对 `modelPreference` 的依赖。

**退出条件：** 在测试分支移除 Agent 文件适配器时，只会在已声明的兼容边界产生编译错误或 fixture 失败。

### 阶段 4：可选的版本化 Agent 文件过渡

只有产品需求明确要求替换 `model_preference` 时，才开始本阶段。获批后，应引入显式 schema 版本或其他无歧义 opt-in，同时读取新旧形式、拒绝冲突、提供诊断，并在移除旧拼写前发布自动重写路径。

过渡必须覆盖普通 Agent 文件、严格 route sidecar、Plugin 提供的 Agent 文件和两个引擎。在这些条件具备前，保留 `model_preference` 是目标态，而不是临时技术债。

### 阶段 5：随 v1 引擎一起退役 v1 词汇

只有旧版引擎通过独立兼容流程退役时，才移除 v1 专属类型与文档。词汇清理本身不足以成为移除引擎的理由。

## 兼容性约束

除非另有明确的 breaking change 裁决，每个迁移阶段都必须保留以下契约：

- v2 委派表面上的 `model` 与 `model_alias` 继续互斥。
- Agent 文件和 profile route sidecar 中的 `model_preference` 与 `model_alias` 继续互斥。
- 字面值名为 `primary` 或 `secondary` 的已配置 alias，继续可通过 `model_alias` 寻址；符号选择不能截获它。
- 精确已配置模型 key 优先于 bare ID 候选；未知的限定 ID 不做后缀匹配；有歧义的 bare ID 必须报错并列出候选。
- Agent 文件的 `thinking_effort` 与 v2 工具参数 `effort` 都与模型选择器独立解析。
- 恢复或重试的子 Agent 保持已持久化的模型与 effort 绑定；resume 不得重新解释当前 profile 或默认值。
- 次主力模型 feature gate 继续控制符号 / 模型池行为，但不能关闭稳定的 `model_alias` 绑定。
- 只要两个引擎都加载 Agent 文件格式，该格式的变更就必须同步更新 v1 与 v2 解析器。
- 普通 Agent 文件中来自其他工具的 `model` 元数据，在没有显式 schema opt-in 时不得获得 Kiki 模型选择行为。

## 源码索引

当前行为由以下仓库路径支撑：

- **v1 已配置 key 解析**：`packages/agent-core/src/config/model.ts`
- **v1 Agent 文件解析**：`packages/agent-core/src/profile/agentfile/parser.ts`
- **v1 子 Agent 绑定**：`packages/agent-core/src/session/subagent-binding.ts`
- **v2 已配置 key 解析**：`packages/agent-core-v2/src/kosong/model/modelService.ts`
- **v2 委派 schema 与绑定**：`packages/agent-core-v2/src/agent/tools/agent/agent.ts` 和 `packages/agent-core-v2/src/session/subagent/configSection.ts`
- **v2 Agent 文件解析**：`packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentFile.ts`
- **v2 profile route 解析**：`packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRouteFile.ts`

## 下一步

- [Agent 与 subagent](../customization/agents.md#agent-文件格式) — 当前 Agent 文件字段与子 Agent 绑定行为。
- [配置文件](../configuration/config-files.md#secondary-model) — 当前模型注册表与次主力模型配置。
- [Kiki 运行时边界](./kiki-runtime.md) — 继承行为与 Kiki 模型绑定改造之间的责任边界。
