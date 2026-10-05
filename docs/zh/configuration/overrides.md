# 配置覆盖

Kiki 有三个地方可以影响运行参数：配置文件、命令行选项、环境变量。它们不是简单的"谁优先级高谁赢"——三者面向不同场景，作用范围互不相同：

- **配置文件** 保存长期偏好（模型、循环控制等），供应商凭证放在配套的 `credentials.toml` 里；两者每次启动都生效
- **命令行选项** 做本次启动的临时切换，退出后失效
- **环境变量** 主要负责数据目录定位、OAuth 端点切换，以及少数运行时开关——**不是配置字段的通用后备来源**

这个区别很关键：很多人会在 shell 里 `export KIMI_API_KEY=xxx`，以为 CLI 会自动取到，但实际上不会。原因见下文[供应商凭证](#供应商凭证)。

## 环境变量的两类作用

环境变量按作用分两类，不能合并成一条线性优先级：

1. **定位配置文件**：`KIKI_HOME` 决定数据根目录，配置文件路径因此变为 `$KIKI_HOME/config.toml`，其配套的凭证文件为 `$KIKI_HOME/credentials/credentials.toml`。这一步先于其他所有解析，不是普通参数的后备来源。
2. **运行端点与诊断**：`KIKI_CODE_OAUTH_HOST`、`KIKI_CODE_BASE_URL`、`KIKI_LOG_LEVEL` 等在 OAuth 或日志子系统初始化时读取。完整列表见[环境变量](./env-vars.md)。

## 普通运行参数的优先级

对模型别名、Plan 模式、yolo 模式、Skills 目录等普通运行参数，优先级从高到低：

1. **命令行选项**（`-m`、`--plan`、`--yolo` 等）：仅对本次启动生效
2. **用户配置文件**（`~/.kiki/config.toml`）：保存长期偏好

少数环境变量明确覆盖特定配置字段，例如 `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` 的优先级高于 `[background].keep_alive_on_exit`。这类例外在[环境变量](./env-vars.md)和[配置文件](./config-files.md)对应字段里都有标注。

::: warning
**普通运行参数不会从 shell 环境变量取后备值。** 供应商的 `api_key` / `base_url` 只从配置文件读取——密钥在 `credentials.toml`，其余在 `config.toml`——不会回退到 shell 里 `export` 的变量。唯一的例外是显式的 `KIKI_MODEL_*` 通道——详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kiki-model)。
:::

CLI 从 `KIKI_HOME`（默认 `~/.kiki`）读取用户级配置，并从 `<项目根目录>/.kiki/local.toml` 读取项目级设置。旧的 `.kimi-code/local.toml` 路径不会读取。需要在不同项目间隔离配置时，用 `KIKI_HOME` 指向不同的数据目录——见下文[典型场景](#典型场景)。

## 供应商凭证

供应商凭证（`api_key`、`base_url`）有独立的解析规则，不走普通参数的优先级链。

供应商的 API 密钥存放在数据根目录下的 `credentials/credentials.toml`。Kiki 把两个文件当作一份文档读取，同一条 TOML 路径上 `credentials.toml` 的值优先；`config.toml` 不会保存明文凭证。文件位置、权限以及首次加载迁移见[供应商凭证](./config-files.md#供应商凭证)。

对单个供应商，凭证按以下顺序解析：

1. `[providers.<name>].api_key` — 存放在 `credentials.toml` 里的密钥，优先级最高
2. `[providers.<name>.env]` 子表里的对应键（`KIMI_API_KEY`、`ANTHROPIC_API_KEY` 等）— `api_key` 为空时才读这里；这些密钥值同样存放在 `credentials.toml`
3. 两者都缺 → 启动报错，提示该供应商缺少凭证

`base_url` 的解析方式相同：先读 `[providers.<name>].base_url`，再读 `[providers.<name>.env]` 里的 `*_BASE_URL` 键。`base_url` 不是密钥，仍留在 `config.toml`。

> `[providers.<name>.env]` 子表只是配置文件里的一段 TOML，不会真正写入 shell 环境变量。仅当对应的直接字段（`api_key` / `base_url`）为空时，CLI 才会查这里。

完整的凭证键名列表见[环境变量：供应商凭证键](./env-vars.md#供应商凭证键)。

## 命令行选项

启动时传入的选项优先级最高，只对本次启动生效：

| 选项 | 作用 |
| --- | --- |
| `-S, --session [id]` | 恢复指定会话；不带 id 时进入交互式选择 |
| `-c, --continue` | 续上当前目录的上一次会话 |
| `-y, --yolo` | 自动批准普通工具调用，Agent 仍可能提问 |
| `--auto` | 以 auto 权限模式启动：普通操作自动批准，受保护访问先请求审批，Agent 仍可提问 |
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

先确定本次派发使用的模型，再解析该模型的 thinking effort。Route 与 caller lease 上的 pin 是可以被覆盖的默认值；`allowed_models`、`deny_models`、`allowed_efforts` 在每个 profile、lease、树策略与匹配 `model_profiles` 作用域都是硬限制——对 subagent 而言，越界会拒绝绑定、人工切换与恢复；在主会话中则以你的选择为准，越界只警示。模型本身不支持的值则无论哪种情况都会报错。

profile 绑定时——新建主会话、新建 subagent、切换模型，或原生 `AgentRun` 派发——先从该角色自身的来源取出请求的 effort，再对照所绑定的模型解析：

1. 调用时显式传入的 `effort`。
2. 主会话中取 persona 或 route 上锁定的 effort；subagent 中取 route 上锁定的 effort，route 未锁定时改用 caller lease 的。两者其后都是匹配的 `model_profiles` 条目，再后是 profile 顶层的 `thinking_effort`。
3. 所绑定模型的首选 effort。
4. `[models."<alias>"].overrides.default_effort`。
5. 模型自身的 `default_effort`。

如果以上都取不到值，或解析出的 effort 不被该模型支持，绑定会以配置错误失败，而不是悄悄替你挑一个。完全没有配置模型时，绑定会同时要求提供模型和 effort。只要 route、lease、profile pin 或模型默认里已经有可用值，就不必每次都传 effort；只有全都取不到时才需要，此时配置相应的 pin 或在本次调用里提供 `effort`。

这些规则只作用于 profile 绑定。保留既有有效绑定的普通 resume 不会重新计算，因此早先保存的 effort 继续有效。只修改 `effort` 时保留已保存的模型；resume 时切换模型仍需 `allow_model_change: true`。

不经过 profile 绑定的路径保持原样：全局 `[thinking]` 仍提供兜底，`[thinking].enabled = false` 在这些路径上仍会把未固定的 effort 解析为 Off。

## 提示词字段优先级

提示词文案字段使用独立的优先级链。从低到高：全局 `[prompt.overrides]`、模型 `[models."<alias>".prompt_overrides]`、Agent 或 `SYSTEM.md` Frontmatter 的 `prompt_overrides`，然后是匹配的 `model_profiles[].prompt_overrides`。Agent 文件与 `SYSTEM.md` 位于同一层，所以 4 层里一共 5 个配置表面。

每个表面都接受 `files` 与 `fields`。文件从 Kiki 主目录读取，按列表顺序应用，随后由同一表面的内联字段覆盖。高层未声明的字段继承低层值，字段值绝不会拼接。外部文件 schema、常用字段示例，以及从已移除的 `prompt.shared` / `prompt.tools` 键迁出的方法见 [`prompt`](./config-files.md#prompt)。

## 典型场景

**隔离测试环境**——用单独的数据目录，避免污染主配置和会话：

```sh
KIKI_HOME="$PWD/.kiki-sandbox" kiki
```

**一次性使用测试密钥**——由于供应商凭证只从配置文件读，把测试密钥写进 `credentials.toml`：

```toml
# ~/.kiki/credentials/credentials.toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

**本次会话自动批准工具调用**：

```sh
kiki --yolo
```

`--yolo` 作用于交互式会话，不能与 `-p` 组合使用——见上文互斥规则。

**临时进入 Plan 模式**（若想永久生效，在配置文件设 `default_plan_mode = true`）：

```sh
kiki --plan
```

## 下一步

- [配置文件](./config-files.md) — 所有可配置字段的完整参考
- [环境变量](./env-vars.md) — `KIKI_HOME` 等变量的完整列表与说明
