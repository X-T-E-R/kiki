# 提示词字段与覆写

提示词字段覆写（Prompt field overrides）用于替换内置提示词中的具名文本单元——系统段、工具描述和委托通知——而无需分叉 agent profile。字段值是替换，不是追加、前置或包裹。

Kiki 提供只读界面来发现和校验这些字段：`kiki prompt-fields`。完整的字段注册表、覆写格式、优先级与校验规则由[配置文件：`prompt`](../configuration/config-files.md#prompt) 一节承载——本页说明这些部分如何配合。

## 可以覆写什么

常用的内置字段 id 包括 `system.language`、`system.reply_style`、`system.coding`、`system.shared`、`tool.web-search.description`、`tool.web-search.guidance`、`delegation.sub.notice` 和 `delegation.independent.notice`。系统字段替换内置提示词的对应段；`system.shared` 是唯一共享的外加段，非空时追加一次。工具 `description` 替换其静态描述；工具 `guidance` 追加在已有的 `User-configured guidance:` 标签之下。

## 覆写写在哪里

每个覆写面使用相同的格式——可选 `files`（相对 Kiki home 的严格 TOML 文件）和内联 `fields`：

| 覆写面 | 位置 |
| --- | --- |
| 全局 | `config.toml` 的 `[prompt.overrides]` |
| 按模型 | `config.toml` 的 `[models."<alias>".prompt_overrides]` |
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

已移除的 `prompt.shared` 和 `prompt.tools` 键已迁入 `[prompt.overrides]` 下的字段；请迁移旧条目，不要恢复这些键——见[提示词字段优先级](../configuration/overrides.md#提示词字段优先级)。

## 桌面版设置入口

在桌面 GUI 中，打开 **Settings → Agents → Prompt** 编辑此段——见[设置页导览](../guides/settings.md#agents)。卡片默认折叠。

## 下一步

- [配置文件：`prompt`](../configuration/config-files.md#prompt) —— 完整字段注册表、覆写格式与校验规则
- [`kiki` 命令参考](../reference/command.md) —— CLI 入口的命令行旗标
- [Agent 与 subagent](../customization/agents.md) —— agent 文件与 `prompt_overrides` frontmatter
