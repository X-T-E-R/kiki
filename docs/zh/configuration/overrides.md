# 配置覆盖

Kiki 有三个地方可以影响运行参数：配置文件、命令行选项、环境变量。它们不是简单的"谁优先级高谁赢"——三者面向不同场景，作用范围互不相同：

- **配置文件** 保存长期偏好（模型、密钥、循环控制等），每次启动都生效
- **命令行选项** 做本次启动的临时切换，退出后失效
- **环境变量** 主要负责数据目录定位、OAuth 端点切换，以及少数运行时开关——**不是配置字段的通用后备来源**

这个区别很关键：很多人会在 shell 里 `export KIMI_API_KEY=xxx`，以为 CLI 会自动取到，但实际上不会。原因见下文[供应商凭证](#供应商凭证)。

## 环境变量的两类作用

环境变量按作用分两类，不能合并成一条线性优先级：

1. **定位配置文件**：`KIKI_HOME` 决定数据根目录，配置文件路径因此变为 `$KIKI_HOME/config.toml`。这一步先于其他所有解析，不是普通参数的后备来源。
2. **运行端点与诊断**：`KIMI_CODE_OAUTH_HOST`、`KIMI_CODE_BASE_URL`、`KIMI_LOG_LEVEL` 等在 OAuth 或日志子系统初始化时读取。完整列表见[环境变量](./env-vars.md)。

## 普通运行参数的优先级

对模型别名、Plan 模式、yolo 模式、Skills 目录等普通运行参数，优先级从高到低：

1. **命令行选项**（`-m`、`--plan`、`--yolo` 等）：仅对本次启动生效
2. **用户配置文件**（`~/.kiki/config.toml`）：保存长期偏好

少数环境变量明确覆盖特定配置字段，例如 `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` 的优先级高于 `[background].keep_alive_on_exit`。这类例外在[环境变量](./env-vars.md)和[配置文件](./config-files.md)对应字段里都有标注。

::: warning
**普通运行参数不会从 shell 环境变量取后备值。** 供应商的 `api_key` / `base_url` 只从 `config.toml`（包括 `[providers.<name>.env]` 子表）读取，不会回退到 shell 里 `export` 的变量。唯一的例外是显式的 `KIMI_MODEL_*` 通道——详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。
:::

CLI 从 `KIKI_HOME`（默认 `~/.kiki`）读取用户级配置，并从 `<项目根目录>/.kiki/local.toml` 读取项目级设置。旧的 `.kimi-code/local.toml` 路径不会自动加载；运行 `kiki migrate-config --workspace <目录>` 将其复制到 `.kiki/`。需要在不同项目间隔离配置时，用 `KIKI_HOME` 指向不同的数据目录——见下文[典型场景](#典型场景)。

## 供应商凭证

供应商凭证（`api_key`、`base_url`）有独立的解析规则，不走普通参数的优先级链。

对单个供应商，凭证按以下顺序解析：

1. `[providers.<name>].api_key` — 配置文件里直接写的密钥，优先级最高
2. `[providers.<name>.env]` 子表里的对应键（`KIMI_API_KEY`、`ANTHROPIC_API_KEY` 等）— `api_key` 为空时才读这里
3. 两者都缺 → 启动报错，提示该供应商缺少凭证

`base_url` 的解析方式相同：先读 `[providers.<name>].base_url`，再读 `[providers.<name>.env]` 里的 `*_BASE_URL` 键。

> `[providers.<name>.env]` 子表只是配置文件里的一段 TOML，不会真正写入 shell 环境变量。仅当对应的直接字段（`api_key` / `base_url`）为空时，CLI 才会查这里。

完整的凭证键名列表见[环境变量：供应商凭证键](./env-vars.md#供应商凭证键-写在-config-toml-里)。

## 命令行选项

启动时传入的选项优先级最高，只对本次启动生效：

| 选项 | 作用 |
| --- | --- |
| `-S, --session [id]` | 恢复指定会话；不带 id 时进入交互式选择 |
| `-c, --continue` | 续上当前目录的上一次会话 |
| `-y, --yolo` | 自动批准普通工具调用，Agent 仍可能提问 |
| `--auto` | 以 auto 权限模式启动：完全自主，Agent 不会向用户提问 |
| `--plan` | 以 Plan 模式启动 |
| `-m, --model <model>` | 指定本次使用的模型别名 |
| `-p, --prompt <prompt>` | 非交互模式：执行单条提示词后退出 |
| `--output-format <format>` | `-p` 模式的输出格式：`text` 或 `stream-json` |
| `--skills-dir <dir>` | 替换自动发现的 Skills 目录（可重复，仅本次生效） |

互斥规则（违反时启动报错）：

- `--output-format` 只能配合 `-p` 使用
- `--prompt` 不能同时用 `--yolo` 或 `--plan`
- `--continue` 和 `--session` 不能同时用
- 非 prompt 模式下，`--yolo` 和 `--plan` 不能配合 `--continue` 或 `--session`

::: tip
`--skills-dir` 是一次性替换，只影响本次启动。如需长期追加搜索目录，在 `config.toml` 里写 `extra_skill_dirs`（详见 [Agent Skills](../customization/skills.md)）。
:::

## 模型与 effort 解析

在原生 executor 上，先确定本次派发使用的模型，再解析该模型的 thinking effort；既有 route、lease 与调用方限制仍需满足。

Thinking effort 按以下顺序解析：

1. 显式 `effort` 必须符合所选模型的锁定值与能力。
2. 未显式传入时，既有 route 或 lease 锁优先。
3. 匹配的 `model_profiles` 条目。
4. profile 顶层的 `thinking_effort`，但仅当所选模型匹配 profile 的默认 `model_alias`。
5. `[models."<alias>"].overrides.default_effort`。
6. `[thinking]` 全局默认值。
7. 模型自身的 catalog 或 capability 默认值。

没有 `model_alias` 的 profile 只跳过顶层 effort 这一层，不会 fail closed；解析会继续使用下一层默认值。普通 resume 省略模型参数时保持当前绑定；alias 解析到同一规范模型时为 no-op。只修改 `effort` 时保留已保存的模型；切换到不同规范模型且省略 `effort` 时，按新模型重新解析 effort。恢复时切换到不同规范模型仍需 `allow_model_change: true`。既有参数校验以及外部 executor 自行完成的校验继续生效。

## 提示词字段优先级

提示词文案字段使用独立的五表面链，不走普通的 CLI / 配置优先级。从低到高依次为全局 `[prompt.overrides]`、模型 `[models."<alias>".prompt_overrides]`、Agent 或 `SYSTEM.md` Frontmatter 的 `prompt_overrides`，以及匹配的 `model_profiles[].prompt_overrides`。`SYSTEM.md` 占用这条链中的 profile 位置，因此共有 4 个优先级层、5 个受支持的配置表面。

每个表面都接受 `files` 与 `fields`。文件从 Kiki 主目录读取，按列表顺序应用，随后由同一表面的内联字段覆盖。高层未声明的字段继承低层值，字段值绝不会拼接。外部文件 schema、常用字段示例、turn 快照，以及从已移除 `prompt.shared` / `prompt.tools` 键迁移的方法见 [`prompt`](./config-files.md#prompt)。

## 典型场景

**隔离测试环境**——用单独的数据目录，避免污染主配置和会话：

```sh
KIKI_HOME="$PWD/.kiki-sandbox" kiki
```

**一次性使用测试密钥**——由于供应商凭证只从配置文件读，把测试密钥写进 `env` 子表：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

**跳过审批运行批处理任务**：

```sh
kiki --yolo -p "批量重命名以下文件..."
```

**临时进入 Plan 模式**（若想永久生效，在配置文件设 `default_plan_mode = true`）：

```sh
kiki --plan
```

## 下一步

- [配置文件](./config-files.md) — 所有可配置字段的完整参考
- [环境变量](./env-vars.md) — `KIKI_HOME` 等变量的完整列表与说明
