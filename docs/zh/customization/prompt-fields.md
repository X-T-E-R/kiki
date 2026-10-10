# 提示词字段与覆写

提示词字段覆写用于替换内置提示词中的具名片段——系统段、工具描述、委托通知——而无需分叉 profile。字段值是替换，不是追加、前置或包裹。

`kiki prompt-fields` 是发现和检查这些字段的只读命令。注册表、格式、优先级与校验规则在[配置文件：`prompt`](../configuration/config-files.md#prompt)，本页说明各部分如何配合。

## 可以覆写什么

常用的内置字段 id 包括 `system.language`、`system.reply_style`、`system.coding`、`system.shared`、`tool.web-search.description`、`tool.web-search.guidance`、`delegation.sub.notice` 和 `delegation.independent.notice`。系统字段替换内置提示词的对应段，只有 `system.shared` 是共享的外加段，非空时追加一次。工具 `description` 替换其静态描述；工具 `guidance` 追加在已有的 `User-configured guidance:` 标签之下。

## 覆写写在哪里

每个覆写面使用相同的格式——可选 `files`（相对 Kiki home 的严格 TOML 文件）和内联 `fields`：

| 覆写面 | 位置 |
| --- | --- |
| 全局 | `config.toml` 的 `[prompt.overrides]` |
| 按模型 | `config.toml` 的 `[models."<alias>".prompt_overrides]` |
| 模型 Recipe | 模型所选 Recipe 中的 `prompts.fields` |
| Profile Recipe | profile 所选 Recipe 中的 `prompts.fields` |
| Agent 或 `SYSTEM.md` frontmatter | frontmatter 中的 `prompt_overrides:` |
| 模型 profile 条目 | agent 文件中的 `model_profiles[].prompt_overrides` |

优先级从低到高按表顺序；缺失的键继承较低层的值。完整格式、`${name}` 变量替换规则和校验失败行为见 [`prompt`](../configuration/config-files.md#prompt)。

## 用 `kiki prompt-fields` 发现与校验

`kiki prompt-fields` 只读，不会修改 `config.toml`、`SYSTEM.md`、agent profile 或覆写文件。

```sh
kiki prompt-fields list                       # 列出所有已注册字段及其所有者、消费方与覆写策略
kiki prompt-fields show system.language       # 默认模板、空值策略、允许的变量
kiki prompt-fields validate --config ./candidate.toml --home ~/.kiki   # 校验配置中的覆写
kiki prompt-fields explain delegation.sub.notice --agent reviewer --model fast --delegation-position sub
```

`explain` 打印字段的 `effective`、`shadowed` 或 `inactive` 状态、当前生效值，以及所选上下文下的完整来源链。用 `--agent`、`--model`、`--executor` 和 `--delegation-position <main|sub|independent>` 选择上下文；`--config <path>` 检查其他配置文件，`--home <dir>` 选择用于 `SYSTEM.md`、agent 发现和相对覆写文件的 Kiki home。

配置里如果还留着旧的 `prompt.shared` 和 `prompt.tools` 键，把这些条目迁到 `[prompt.overrides]` 下的字段，不要恢复旧键——见[提示词字段优先级](../configuration/overrides.md#提示词字段优先级)。

## Recipe 模型配方

Recipe 把模型调教打包成可复用配方：提示词字段、system/steering/anchor 正文，以及模型设置。Recipe 默认开启，可在[模型编辑器](../guides/settings.md#模型与-recipe)中使用，也可通过 [客户端 SDK](../server/sdk.md) 的 `global.recipes` 使用。服务端显式设置 `KIKI_EXPERIMENTAL_RECIPES=false` 或 `[experimental] recipes = false` 时仍会关闭；移除该覆盖即可采用默认值。

用绝对路径创建包目录，其中放入 `recipe.toml`。提示词文件必须是该目录内的 Markdown 相对路径：

```toml
schema_version = 1
id = "example"
name = "Example"
version = "1.0.0"

[model.parameters]
temperature = 0.35

[prompts]
steering = { text = "围绕当前目标推进。" }
steering_on_turn = true
steering_on_input = true
steering_interval_steps = 0

[prompts.fields]
"system.reply_style" = "直接、简洁地回答。"
```

`prompts.fields` 接受所有已注册且可写的提示词字段，复用原有变量与空值校验。`model` 复用 [逐模型配置](../configuration/config-files.md#models) 的语法与校验，承载参数、usage 预算和 behavior 等调教设置；不能更改供应商路由、凭据、请求身份或权限。参数和 behavior 仍跨 Agent 位置共享；原有 main/independent usage 预算保留各自含义。

包还可携带 [脚本 hooks](./hooks.md#recipe-脚本-hooks)。检查 `preview.hooks`，取得用户明确的安装同意后，才能为含脚本包发送 `consent: true`；不能根据 `consent_required` 自动同意。下例没有脚本，不增加脚本确认。

已有客户端连接时，安装并选择本地包：

```ts
const preview = await klient.global.recipes.preview({ source: { locator: "/absolute/path/to/example" } });
const installed = await klient.global.recipes.install({ preview_id: preview.preview_id });
const model = await klient.global.kosong.readModel("example-model");
await klient.global.kosong.updateModel("example-model", {
  recipe: installed.installation_id,
  base_revision: model.revision,
});
```

Profile 可引用同一已安装包，不改变全局模型。在 Markdown Frontmatter 中写 `recipe: installation:<已安装 id>`（也可直接写安装 id）；id 来自 `install` 返回值。沿现有 profile Markdown 编辑入口保存，或编辑 profile 文件。URL 和本地路径是先预览、安装的包来源，不会在绑定时隐式下载。

```markdown
---
name: reviewer
description: 审查变更
model_alias: example-model
recipe: installation:YOUR_INSTALLED_ID
request_params:
  temperature: 0.2
---
审查变更并报告可执行的发现。
```

Recipe 只贡献自己声明的值。模型设置依次采用保存模型、模型 Recipe、模型 `overrides` 本地差异、profile Recipe、profile 显式参数、匹配的 `model_profiles` 参数；上下文和输出上限仍取各适用限制的最小值。提示字段依次采用全局、保存模型字段、模型 Recipe 字段、profile Recipe 字段、profile 字段、匹配的 profile-model 或 caller-lease 字段。未覆盖的 cognition 槽和普通模型 profile 正文继续生效；角色、persona、工作区指令、宿主上下文与权限保留原有权威。

用当前 `base_revision` 写模型 `recipe: null`，或在 profile 中写 `recipe: off`，只撤回对应层的配方贡献。手动值和另一层 Recipe 都保留。新绑定冻结每个引用包的 revision、展开正文与有效模型设置，包括继承来的参数。已有会话和冷恢复保留该快照，直到重建上下文或显式换模；订阅更新与 profile 编辑不会暗中换绑。

### 继承或自定义

包可在各表之前用 `extends = { source = "https://example.com/presets/recipe.toml" }` 声明一个父配方。缺失 slot 继承；每个正文来源或来源数组整体替换父值。模型设置按已声明叶项合并，数组整体替换。根级 `model = "off"` 清除继承的 Recipe 设置，恢复保存的模型设置。`steering = "off"` 等正文 slot 删除本包继承的该项；字段值 `false` 删除继承的 Recipe 字段。其他模型或 profile 层仍可提供值。

`prompts` 是 subagent 使用的 common 分支。`[prompts.main]` 或 `[prompts.independent]` 选择一个完整的位置分支，不会自动用 common 填补缺失 slot。在 `[prompts]` 内写 `main = "same"` 或 `independent = "same"` 可显式采用 common，写 `"off"` 则禁用整个分支。正文 slot 接受 `{ text = "..." }`、`{ file = "prompt.md" }` 或这些来源的数组。anchor 使用 `{ content = { text = "..." }, steps = 1, scope = "session" }`；`scope` 也接受 `"turn"`。

Steering 节奏属于所选分支；未声明项沿用下层值。所有层均未声明时，`steering_on_turn` 默认 `true`，用于新轮次及压缩后的重新注入；`steering_on_input` 默认 `true`，用于已物化的明确用户输入；`steering_interval_steps` 默认 `0`，不额外周期注入。正整数间隔统计本 Agent 距最近注入的实际模型 loop step，不是秒数或工具调用次数。

`global.recipes.fork` 可生成独立的 `copy` 或继承父源的 `extend` 子配方；用 `saveLocal` 和 `expected_revision` 校验编辑生成的本地包。已安装包锁定完整依赖链，可离线使用。`follow` 每日检查更新；`pinned` 保留已接受版本。无效更新保留整个上次接受的 revision。HTTPS ZIP 源必须提供 `sha256`，继承的 ZIP 源也可在 `extends` 中携带。预览与安装接受同一份已检查快照，安装时不再次下载来源。

分享本地定制时，先保存草稿，再调用 `global.recipes.export(installation_id)`。返回 `{ name, revision, files }`：建议的 ZIP 文件名、来源已接受的 revision，以及相对路径文件映射。客户端把这些文件打成 ZIP；继承的正文、模型设置与 cadence 已全部展开，不携带父安装引用，因此另一个 Kiki home 可以独立预览、安装。导出不会创建安装、更改模型、修改原文件或上传内容。重新导入会生成自己的 revision；导出结果中的 `revision` 标识发送方已接受的版本。

## 桌面版设置入口

在桌面版中，**设置 → 智能体 → 提示词字段**可以编辑这一段——见[设置页导览](../guides/settings.md#智能体)。卡片默认折叠。

## 下一步

- [配置文件：`prompt`](../configuration/config-files.md#prompt) —— 完整字段注册表、覆写格式与校验规则
- [`kiki` 命令参考](../reference/command.md) —— CLI 入口的命令行旗标
- [Agent 与 subagent](../customization/agents.md) —— agent 文件与 `prompt_overrides` frontmatter
