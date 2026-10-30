# 提示词字段与覆写

提示词字段覆写用于替换内置提示词中的具名片段——系统段、工具描述、委托通知——而无需分叉 profile。字段值是替换，不是追加、前置或包裹。

`kiki prompt-fields` 是发现和检查这些字段的只读命令。注册表、格式、优先级与校验规则在[配置文件：`prompt`](../configuration/config-files.md#prompt)，本页说明各部分如何配合。

## 可以覆写什么

常用的内置字段 id 包括 `system.language`、`system.reply_style`、`system.coding`、`system.shared`、`tool.web-search.description`、`tool.web-search.guidance`、`delegation.sub.notice` 和 `delegation.independent.notice`。系统字段替换内置提示词的对应段，只有 `system.shared` 是共享的外加段，非空时追加一次。工具 `description` 替换其静态描述；工具 `guidance` 追加在已有的 `User-configured guidance:` 标签之下。

Kiki 的内置协作指引无需 Recipe 即可使用：把完整成果交给一个 owner，收到结果后检查实际产物、纳入目标再记为接受，通信只发送收件人下一步仍缺的输入。模型、route 和工具方面的要求通过 `AgentRun` 参数和所选角色落实，不在给 subagent 的指令里重复。用户要求的讨论不受消息条数配额限制。回复语言沿用用户或任务 brief 的语言及明确的回复语言要求，不因内部 steering、提醒或引用文档而自行切换。可通过 `system.delegation_brief_hygiene`、`delegation.sub.notice`，以及 `tool.agent-run`、`tool.agent-send`、`tool.thread-send` 的 `description` 和 `guidance` 字段定制这些指引。

这些默认值保留既有 profile 与 Recipe 覆写、委托通知的关闭选择，以及角色和工具限制。自定义替换型 profile 仍决定自己的正文。外部执行器通过所选 profile 或已配置的 `executor_prompt` 组合接收相应文本；未启用这些补充的[外部直连执行](./agents-and-subagents.md#外部直连执行)仍保持原样运行。

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

已有 Agent 恢复时保留绑定时的提示词字段、自定义变量和 cognition 文本，即使来源文件后来被修改或删除。修改对新绑定生效；要在已有会话里采用新内容，选择[重建上下文](./agents-and-subagents.md#重建会话上下文)。显式换模会选择目标模型的提示词输入；单独设置 `new_window` 不会重新加载提示词来源。当前工具权限与模型硬约束仍然生效。

旧记录优先复用已保存的系统提示词，并尽可能从保存的 profile 还原内联字段。若记录从未保存必需的共享字段、工具覆写、steering 提示或 anchor，且原始输入已无法重建，恢复错误会点名缺失的输入。此时重建上下文以采用当前来源，无需回滚已安装的新提示词。

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

Recipe 把模型调教和可选择的提示词正文打包成可复用配方：提示词字段、system/steering/anchor 正文，以及模型设置。Recipe 默认开启，可在[模型编辑器](../guides/settings.md#模型与-recipe)中使用，也可通过 [客户端 SDK](../server/sdk.md) 的 `global.recipes` 使用。服务端显式设置 `KIKI_EXPERIMENTAL_RECIPES=false` 或 `[experimental] recipes = false` 时仍会关闭；移除该覆盖即可采用默认值。

用绝对路径创建包目录，其中放入 `recipe.toml`。提示词文件必须是该目录内的 Markdown 相对路径：

```toml
schema_version = 1
id = "example"
name = "Example"
version = "1.0.0"

[options.research]
name = "Research guidance"
description = "Include source-checking guidance"
default = true

[model.parameters]
temperature = 0.35

[prompts]
system = { text = "提出事实性结论时引用来源。", when = "research" }
steering = { text = "围绕当前目标推进。" }
steering_on_turn = true
steering_on_input = true
steering_interval_steps = 0

[prompts.fields]
"system.reply_style" = "直接、简洁地回答。"
```

`[options.<id>]` 表必须包含 `name` 和布尔值 `default`；`description` 可选。选项 id 使用与 Recipe id 相同的正则：`^[a-z0-9][a-z0-9._-]*$`。

`system`、`steering`、`anchor.content` 或 `steering_sources.<source>` 下 `custom.steering` 的正文源可以是一个 `{ text = "..." }` 或 `{ file = "..." }`，也可以是这些来源组成的数组。每个来源可以使用 `when = "<option-id>"` 或 `unless = "<option-id>"`，但不能同时使用。门控引用未声明的选项会报错，`off` 不能添加门控。过滤掉全部来源后，该 slot 仍是已声明的空 slot；`extends` 不会为它回退到父配方。

`prompts.fields` 接受所有已注册且可写的提示词字段，复用原有变量与空值校验。选项只影响提示词正文，不影响模型、hooks、权限或 fields。`model` 复用 [逐模型配置](../configuration/config-files.md#models) 的语法与校验，承载参数、usage 预算和 behavior 等调教设置；不能更改供应商路由、凭据、请求身份或权限。参数和 behavior 仍跨 Agent 位置共享；原有 main/independent usage 预算保留各自含义。

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

模型的 `recipe` 也可引用本地文件或包目录，例如 `./focus/recipe.toml`。相对路径以声明该引用的配置为基准：继承来的引用仍按主空间配置目录解析，本地覆盖则按当前配置目录解析。绝对路径保持原含义。

Profile 可引用同一已安装包，或一份本地 Recipe 文件，且不改变全局模型。在 Markdown Frontmatter 中写 `recipe: installation:<已安装 id>`（也可直接写安装 id）；id 来自 `install` 返回值。本地文件或包目录同样可用：`recipe: ./focus/recipe.toml`，或绝对路径。Profile 的相对路径按自身文件所在目录解析，并在绑定时直接读取。

模型的 Recipe 可用 `recipe_options = { research = true }` 选择正文选项，profile 的 Recipe 可在 frontmatter 中用 `recipe_options:` 选择。每一层只把选择应用于自己的 Recipe 包；未写选择时使用选项的 `default`。选择了未知 id 时正文保持不变，只生成配置诊断。在 GUI 中，现有模型编辑器和声明了 Recipe 的 profile 现有编辑位置会把这些选项显示为复选框。

不改变绑定即可查看生效的选项值：REST 使用 `GET /api/recipes/{id}?recipe_options=<经过 URL 编码的 JSON 布尔映射>`，klient API 使用 `klient.global.recipes.get(id, values)`。

这不会安装该文件，绑定也不会下载 URL。沿现有 profile Markdown 编辑入口保存，或编辑 profile 文件。直接引用的文件若带脚本 hooks，仍须走现有安装确认；`hooks = "off"` 不贡献脚本。

```markdown
---
name: reviewer
description: 审查变更
model_alias: example-model
recipe: installation:YOUR_INSTALLED_ID
recipe_options:
  research: true
request_params:
  temperature: 0.2
---
审查变更并报告可执行的发现。
```

子空间默认读取主空间已安装的 Recipe；安装 ID 相同时，本地条目优先。继承包只读，要在子空间编辑，先选择**复制**或**扩展**。`inherit.config = false` 只关闭配置继承，不切断这些包的读取，因此仍在继承的 Profile 可以继续解析其已安装 Recipe 引用。子空间中的包更新和移除只写入子空间。

Recipe 只贡献自己声明的值。模型设置依次采用保存模型、模型 Recipe、模型 `overrides` 本地差异、profile Recipe、profile 显式参数、匹配的 `model_profiles` 参数；上下文和输出上限仍取各适用限制的最小值。提示字段依次采用全局、保存模型字段、模型 Recipe 字段、profile Recipe 字段、profile 字段、匹配的 profile-model 或 caller-lease 字段。未覆盖的 cognition 槽和普通模型 profile 正文继续生效；角色、persona、工作区指令、宿主上下文与权限保留原有权威。

在模型或 profile 中写 `recipe: off`，可停用对应层的 Recipe，包括继承来的模型选择。通过 API 更新模型时携带当前 `base_revision`；`recipe: null` 则清除本地选择。手动值和另一层 Recipe 都保留。新绑定冻结每个引用包的 revision、选项值、展开正文与有效模型设置，包括继承来的参数；选项值和 patch 内容均计入 revision，因此结果可以复现。

已有绑定和冷恢复保留该快照。要采用变更后的选项值，请重建上下文或创建新绑定；单独热加载不会立即改变已有绑定。

### 继承或自定义

包可在各表之前用 `extends = { source = "https://example.com/presets/recipe.toml" }` 声明一个父配方。缺失 slot 继承；每个正文来源或来源数组整体替换父值。模型设置按已声明叶项合并，数组整体替换。根级 `model = "off"` 清除继承的 Recipe 设置，恢复保存的模型设置。`steering = "off"` 等正文 slot 删除本包继承的该项；字段值 `false` 删除继承的 Recipe 字段。其他模型或 profile 层仍可提供值。求值 `when` 或 `unless` 之前，选项定义按 id 合并。同 id 的子配方记录整体覆盖父记录，包括 `name`、`default`、`description`、`prepend`、`append` 和 `patch`；父配方的门控按合并后的选项表求值。`extends` 后的选项顺序先保留父配方选项，再追加子配方新增 id；覆盖已有 id 时仍保留父配方原位置。

`prompts` 是 subagent 使用的 common 分支。`[prompts.main]` 或 `[prompts.independent]` 选择一个完整的位置分支，不会自动用 common 填补缺失 slot。在 `[prompts]` 内写 `main = "same"` 或 `independent = "same"` 可显式采用 common，写 `"off"` 则禁用整个分支。正文 slot 接受 `{ text = "..." }`、`{ file = "prompt.md" }` 或这些来源的数组。anchor 使用 `{ content = { text = "..." }, steps = 1, scope = "session" }`；`scope` 也接受 `"turn"`。

Steering 节奏属于所选分支；未声明项沿用下层值。普通 steering 正文与节奏适用于直接用户输入，已核验且完成的 subagent 任务回执也默认继承。明确设置 `steering_sources.task.mode = "off"` 可关闭该继承；普通进程结果、失败子任务及其它非用户来源仍需各自配置。所有层均未声明时，`steering_on_turn` 与 `steering_on_input` 默认 `true`，`steering_interval_steps` 默认 `0`，不额外周期注入。正整数间隔统计本 Agent 由该来源驱动的模型步骤，不是秒数或工具调用次数；关闭的来源在压缩后也保持关闭。

在同一分支中使用 `steering_sources` 开启其他来源：`mode = "inherit"` 在绑定时沿用最终用户正文与节奏，`mode = "custom"` 使用自己的 `custom` 正文与节奏。来源及 custom 字段在父配方、模型 Recipe、profile Recipe 各层按声明的叶项合并，再随绑定冻结；改用户设置不会重写已有会话。来源键与默认值见 [模型认知](../configuration/config-files.md#模型认知)。例如：

```toml
[prompts.steering_sources.thread]
mode = "inherit"

[prompts.steering_sources.task]
mode = "custom"
custom = { steering = { file = "task-cue.md" }, steering_interval_steps = 2 }
```

单独 Recipe 正文接受原有 text/file/array 形式或 `"off"`；后者抑制下层单独正文。Off 与 inherit 模式保留已保存的 custom 草稿。

### 选项插入与章节修改

选项可以在不替换已声明 slot 的情况下插入提示词正文。选项级 `prepend` 和 `append` 是 whole-slot 简写：它们插在整个 slot 的前面或后面，因此 `prepend` 可以出现在标题之前，而不是定位到某个 section 的正文开头。例如：

```toml
[options.citations]
name = "Citations"
default = false
append.main.steering = { text = "Cite sources" }
prepend.common.system = { file = "preface.md" }
```

`prepend` 和 `append` 使用 `common`、`main` 或 `independent` 分支。目标 slot 可以是 `system`、`steering`、`anchor`（指 anchor 的 `content`）或 `steering_sources.<source>`（指该来源的 `custom.steering`）。每个插入 slot 接受一个 `{ text = "..." }` 或 `{ file = "..." }`，也可以接受这些来源组成的数组。完成 `extends` 合并后，每个插入项展开为带 `when = "<option-id>"` 的正文源，插在实际声明 slot 的前面或后面；单个正文源会先按数组处理。

需要按 section 修改正文时，在选项下声明 patch：

```toml
[options.cite]
name = "Citations"
default = false

[[options.cite.patch]]
slot = "main.system"
section = "Sources"
action = "append"
content = { text = "Cite sources." }
```

`slot` 使用与 `prepend`、`append` 相同的 `branch.slot` 语法；`section` 可省略。没有 `section` 时，只允许 `action = "prepend"` 或 `action = "append"`，并将该项转成带 `when = "<option-id>"` 的正文源。有 `section` 时，先按选项门控拼接完整 slot 文本，再按选项声明顺序、每个选项的 patch 数组顺序修改文本；只有开启的选项生效。

section 按标题文本完全匹配，标题层级不限；范围从该标题开始，到下一个同级或更高层级标题之前。fenced code 中以 `#` 开头的行不算标题。section 级 `prepend` 和 `append` 把正文插入正文头或尾；`before` 和 `after` 把内容插入整个 section 的前面或后面；`replace` 替换整个 section，content 必须自带标题；`remove` 删除整个 section，且不能有 content。除 `remove` 外的 action 都必须有 `content`，插入的块之间用空行分隔。未修改的文本逐字节保留；最后一节未被修改时，其末尾换行也保持原样。

完成 `extends` 合并后，目标 slot 必须已声明且不能是 `off`；非法 slot 键、目标缺失或关闭、以及 `content` 带 `when` 或 `unless` 都会报错。开启的 patch 找不到 section，或 section 重复出现时，求值会失败，并在诊断中指出 option id 和 section。插入项自身不能使用 `when` 或 `unless`。

`global.recipes.fork` 可生成独立的 `copy` 或继承父源的 `extend` 子配方；用 `saveLocal` 和 `expected_revision` 校验编辑生成的本地包。已安装包锁定完整依赖链，可离线使用。`follow` 每日检查更新；`pinned` 保留已接受版本。无效更新保留整个上次接受的 revision。HTTPS ZIP 源必须提供 `sha256`，继承的 ZIP 源也可在 `extends` 中携带。预览与安装接受同一份已检查快照，安装时不再次下载来源。

分享本地定制时，先保存草稿，再调用 `global.recipes.export(installation_id)`。返回 `{ name, revision, files }`：建议的 ZIP 文件名、来源已接受的 revision，以及相对路径文件映射。客户端把这些文件打成 ZIP；继承的正文、模型设置与 cadence 已全部展开，不携带父安装引用，因此另一个 Kiki home 可以独立预览、安装。导出不会创建安装、更改模型、修改原文件或上传内容。重新导入会生成自己的 revision；导出结果中的 `revision` 标识发送方已接受的版本。

## 桌面版设置入口

在桌面版中，**设置 → 智能体 → 提示词字段**可以编辑这一段——见[设置页导览](../guides/settings.md#智能体)。卡片默认折叠。

## 下一步

- [配置文件：`prompt`](../configuration/config-files.md#prompt) —— 完整字段注册表、覆写格式与校验规则
- [`kiki` 命令参考](../reference/command.md) —— CLI 入口的命令行旗标
- [Agent 与 subagent](../customization/agents-and-subagents.md) —— agent 文件与 `prompt_overrides` frontmatter
