# Agent Skills

Agent Skills 是 Kiki 扩展模型能力的轻量机制。一个 Skill 就是一份带 YAML frontmatter 的 Markdown 文档，描述某项专业知识或工作流程——例如项目的代码风格规范、PR review 流程、提交消息格式。

相比每次把同样的指引粘到提示词里，Skill 的优势在于：内容沉淀在文件里、可以跨项目和团队复用、可以通过斜杠命令一键加载，也可以让模型在需要时自动调用。

## 自定义提示命令

如果希望输入 `/名称 参数` 后加载自己的一段提示词，可以用 Markdown 定义提示命令。命令复用 Skill 目录与参数展开，但只在你明确发送时加载，不会根据描述进入模型的自动 Skill 调用候选。

在项目根目录创建 `.kiki/commands/brainstorm.md`：

```markdown
---
description: 在选择方案前讨论不同做法
argument-hint: "<讨论主题>"
---
请围绕 $ARGUMENTS 提出几个方案，说明各自的取舍。
如果缺少重要条件，先向我询问。保持讨论，除非我明确要求，
不要创建文档或修改文件。
```

在 GUI 或终端输入 `/`，选择 `brainstorm`，补充主题后发送，例如 `/brainstorm 更简单的设置菜单`。选择条目只会填入草稿，发送时才将正文连同参数和附件加载一次。这只是一个示例，不会自动安装，也不是必须遵循的头脑风暴流程。

Frontmatter（文件开头的 YAML 元数据）可以完全省略：名称默认取文件名，菜单描述默认取正文第一行非空内容。可选的 `name`、`description` 和 `argument-hint` 分别指定名称、描述和参数提示；名称不能包含空白、`/`、`\\` 或 `:`。[正文占位符](#正文占位符)同样适用；没有参数占位符时，参数会附在正文末尾。作为参数插入的值不会再次展开。

用户级命令放在当前应用数据目录的 `commands/*.md`；项目级命令放在项目根目录的 `.kiki/commands/*.md`。只读取目录下直接放置的 Markdown 文件。项目级同名命令优先于用户级。旧的 `.kimi-code/commands/` 目录不会读取。显式指定 Skill 目录仍沿用原有的替换规则。文件修改会被监听；重新打开 GUI 斜杠菜单，或在终端运行 `/reload`，即可刷新菜单。

内置快捷动作保留裸名称：`/plan` 仍用于控制 Plan 模式。与其重名的目录条目会显示为 `/skill:plan`；与已有 Skill 重名的提示命令会显示为 `/command:名称`。以菜单显示的名称为准。命令正文是用户提示词，不是系统提示词或可执行脚本；它不会授予权限、切换模式，也不会把流程图变成工作流引擎。发送前请检查陌生仓库中的命令文件。

## 创建 Skill

Skill 文件需放在[已知的扫描目录](#skill-存放位置)中。支持两种文件结构：

- **目录形式（推荐）**：在 Skills 目录下创建一个子目录，主文件命名为 `SKILL.md`，可在同目录下放置脚本、参考资料等辅助文件。同目录下同时存在 `<name>/SKILL.md` 和同名 `<name>.md` 时，以子目录为准。
- **扁平形式**：直接使用单个 `.md` 文件，Skill 名称取文件名（去掉 `.md`）。

### 文件格式

`SKILL.md` 由 YAML frontmatter 和 Markdown 正文两部分组成：

```markdown
---
name: code-style
description: 项目代码风格规范，定义命名、缩进、注释和文件组织
type: prompt
whenToUse: 当用户让我编写、修改或审查项目源代码时
disableModelInvocation: false
arguments:
  - target
  - mode
---

请按下述规范处理代码：

- 缩进使用 2 空格
- 变量名使用 `camelCase`，类型名使用 `PascalCase`
- 公开函数必须带 TSDoc 注释
- 单行不超过 100 字符
```

### Frontmatter 字段

| 字段 | 说明 |
| --- | --- |
| `name` | Skill 名称。目录型 `SKILL.md` 中为必填；扁平 `.md` 文件省略时使用文件名。名称大小写不敏感 |
| `description` | 一行总结，模型用它来判断何时使用这个 Skill。目录型 `SKILL.md` 中为必填；扁平 `.md` 文件省略时回退到正文第一行非空内容（截至 240 字符） |
| `type` | Skill 类型：`prompt`（默认）、`inline`（与 `prompt` 语义相同）、`flow`（只支持手动调用，不支持模型自动调用）。其他值会被跳过 |
| `whenToUse` | 触发场景描述。也接受 `when-to-use`、`when_to_use` 写法 |
| `disableModelInvocation` | 设为 `true` 时禁止模型自动调用此 Skill。也接受 `disable-model-invocation`、`disable_model_invocation` 写法 |
| `arguments` | 命名参数列表，可写成字符串数组或空白分隔的字符串（如 `arguments: target mode`）。声明后，正文可用 `$<name>` 读取参数 |

::: warning 注意
目录型 `SKILL.md` 中 `name` 和 `description` **必须**显式填写，省略任意一项均会导致解析失败。
:::

### 正文占位符

正文在发送给模型前会展开少量占位符：

- `$ARGUMENTS`：调用时附带的完整原始参数字符串
- `$ARGUMENTS[0]`、`$ARGUMENTS[1]` 及简写 `$0`、`$1`：按空白分词后的位置参数（从 0 开始）
- `$<name>`：`arguments` 中声明的命名参数
- `${KIKI_SKILL_DIR}`：当前 Skill 文件所在目录

位置参数支持单双引号包裹，如 `/skill:commit "fix login" patch` 中 `$0` 展开为 `fix login`。若正文不含任何参数占位符，调用时附带的文本会以 `\n\nARGUMENTS: <文本>` 的形式追加到正文末尾。

## Skill 存放位置

Kiki 按作用域分四档扫描，越具体的作用域优先级越高：**Project > User > Extra > Built-in**

**用户级**（对所有项目生效）：
- `$KIKI_HOME/skills/`（默认：`~/.kiki/skills/`）
- `~/.agents/skills/`

Kiki 专属用户级 Skill 目录会随 `KIKI_HOME` 移动，因此隔离数据根时也会隔离 Kiki 专属 Skills。通用 `~/.agents/skills/` 目录仍放在真实 OS home 下，以便跨工具共享。

**项目级**（项目根 = 工作目录向上最近的含 `.git` 的目录）：
- `.kiki/skills/`
- `.agents/skills/`

**额外目录**：通过 `config.toml` 顶层的 `extra_skill_dirs` 声明：

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

**内置 Skills** 随 CLI 一起分发，优先级最低。它们为常见任务提供开箱即用的工作流，例如配置 MCP server、定制 TUI 主题和编辑配置文件。完整列表详见[内置 Skill 命令](../reference/slash-commands.md#内置-skill-命令)。其中介绍 Kiki Code 自身的部分可以通过顶层 [`builtin_product_skills`](../configuration/config-files.md#顶层字段) 字段关闭。

## 调用 Skill

用户通过斜杠命令主动调用：

```
/skill:code-style
/skill:git-commits 修复登录接口的并发问题
```

模型也可以根据 `description` 和 `whenToUse` 自动调用 Skill（除非 `disableModelInvocation` 设为 `true` 或 `type` 为 `flow`）。Skill 调用时最多允许嵌套 3 层，超过后会被终止。

## 完整示例

```markdown
---
name: review-pr
description: 按团队标准审查一个 Pull Request，输出结构化的 review 报告
type: prompt
whenToUse: 当用户让我审查 PR、检查代码变更或评估提交质量时
arguments:
  - pr_ref
---

请按照以下流程审查用户指定的 PR：$pr_ref

1. 拉取并阅读 `$pr_ref` 的全部 diff。
2. 对照以下检查项逐条核对：
   - 是否包含对应的测试用例
   - 公开 API 是否有文档更新
   - 是否引入了新的依赖；若有，说明引入理由
   - 错误处理是否覆盖了边界情况
3. 参考同目录下的检查清单：`references/checklist.md`
4. 输出一份 review 报告，包含：
   - 总体结论（approve / request changes / comment）
   - 必须修改项（blocking）
   - 建议改进项（non-blocking）
   - 值得肯定的地方
```

保存为 `$KIKI_HOME/skills/review-pr/SKILL.md`（未设置 `KIKI_HOME` 时为 `~/.kiki/skills/review-pr/SKILL.md`），检查清单放在同目录的 `references/checklist.md`，重开会话后即可通过 `/skill:review-pr #1234` 调用，其中 `#1234` 会展开到 `$pr_ref`。

## 下一步

- [Plugins](./plugins.md) — 把 Skills 打包成可安装单元，与团队共享
- [Agent 与 subagent](./agents.md) — Skills 如何影响 subagent 的行为
