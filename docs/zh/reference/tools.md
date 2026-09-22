# 内置工具

内置工具是 Kiki 随核心引擎提供的工具集，无需安装 MCP server 即可使用。Agent 在每次对话中会根据任务需要自动选择并调用这些工具；用户可以通过权限审批界面查看每次工具调用的细节。

与 MCP 工具相比，内置工具由运行时直接管理，生命周期与会话绑定，无需外部进程。两者都遵循统一的审批机制：**只读类工具**（如 `Read`、`Grep`、`Glob`）默认自动放行，**写入与执行类工具**（如 `Write`、`Edit`、`Bash`）默认需要用户审批。YOLO 模式下普通工具调用的审批会被跳过，但 Plan 模式下的退出审批不受影响。

## 文件类

文件类工具负责读取、写入、搜索本地文件系统，是代码分析和修改任务的基础工具。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Read` | 自动放行 | 读取文本文件内容 |
| `Write` | 需审批 | 创建或覆盖文件 |
| `Edit` | 需审批 | 精确字符串替换 |
| `Grep` | 自动放行 | 基于 ripgrep 的全文搜索 |
| `Glob` | 自动放行 | 按 glob 模式查找文件 |
| `ReadMediaFile` | 自动放行 | 读取图片或视频文件 |

**`Read`** 接受文件路径（`path`）以及可选的 `line_offset`（起始行号，支持负数从末尾倒数）和 `n_lines`（读取行数上限）。单次最多返回 1000 行或 100 KB，超出部分会附带截断提示。如果文件是图片或视频，工具会提示改用 `ReadMediaFile`。

**`Write`** 接受 `path`、`content` 和可选的 `mode`（`overwrite` 或 `append`，默认覆盖）。缺失的父目录会自动创建；`append` 模式将内容追加到文件末尾，不自动添加换行。

**`Edit`** 接受 `path`、`old_string`（要替换的精确文本）和 `new_string`（替换后的文本）。默认只替换唯一一处匹配，若文件中存在多处相同内容会报错并提示使用 `replace_all: true`。`old_string` 与 `new_string` 不能相同。

**`Grep`** 调用 ripgrep 搜索文件内容，支持正则表达式（`pattern`）、搜索路径（`path`）、文件类型过滤（`type`，如 `ts`、`py`）、glob 过滤（`glob`）和输出模式（`output_mode`：`files_with_matches` / `content` / `count_matches`，默认 `files_with_matches`）。`content` 模式支持上下文行（`-A`、`-B`、`-C`）、忽略大小写（`-i`）、行号（`-n`，默认 true）、跨行匹配（`multiline`）。所有模式支持 `offset` + `head_limit` 分页，`head_limit` 默认 250、传 0 表示不限。`.env`、私钥等敏感文件会被自动过滤；`include_ignored=true` 可搜索被 `.gitignore` 忽略的文件，但敏感文件仍保持过滤。

**`Glob`** 按 glob 模式（`pattern`）在指定目录（`path`，默认工作目录）中匹配文件，结果按修改时间倒序排列，默认返回 100 条。默认尊重 `.gitignore`、`.ignore` 和 `.rgignore`；设置 `include_ignored=true` 可包含构建产物等被忽略的文件，但敏感文件仍会被过滤。支持 `*.{ts,tsx}` 这类花括号模式，也允许宽泛通配符模式。

使用 `offset`（默认 0）和 `head_limit`（默认 100）对匹配路径分页；有更多结果时，工具会给出下一页的 offset。设置 `head_limit: 0` 可取消条数限制，但字符上限仍然有效：达到上限时，页面会在完整路径处结束，并给出下一页的 offset。较大的页面会保存到文件，Agent 可用 `Read` 读取。每次调用都会重新搜索当前文件系统，因此文件变化可能导致跨页结果移动。超时、目录无法读取或输出采集上限仍可能造成搜索不完整；结果会提示这些情况，增加 offset 无法恢复尚未收集的路径。

**`ReadMediaFile`** 将图片或视频以多模态内容发送给模型。它接受 `path`，以及 `region`、`full_resolution` 等可选的图片细节参数；文件大小上限为 100 MB。默认读图会按配置的模型限制压缩；如果自动压缩无法安全满足限制，工具会返回错误且不发送原图，并提示模型先创建更小的副本再读取。是否可用取决于当前模型的视觉能力（`image_in` / `video_in`）。

## Shell

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Bash` | 需审批 | 执行 Shell 命令 |

**`Bash`** 是权限要求最严格的工具，也是功能最通用的工具。参数：

- `command`（必填）：要执行的 Shell 命令
- `cwd`：工作目录。本地运行时中，Agent 当前有效权限模式为 YOLO 时，可显式指定工作区外的绝对路径；放行不会越过 Agent 权限上限或真实远程/容器隔离。manual/auto 模式及相对路径越界仍受原有工作区边界约束。
- `timeout`：超时时间（毫秒）；前台默认 60 秒、最长 5 分钟
- `run_in_background`：是否以后台任务运行；后台默认 10 分钟超时（print 模式 `kiki -p` 下默认无超时）
- `description`：后台任务描述，`run_in_background=true` 时必填
- `disable_timeout`：后台任务是否取消超时限制

前台模式会阻塞当前轮次，直到命令结束或超时；命令运行期间，TUI 会把 stdout 和 stderr 流式显示在正在运行的 `Bash` 工具卡片中。前台命令超时后默认不会被终止，而是转为后台任务继续运行（受 600 秒默认后台超时约束，即超时转入后台的命令会重新获得最多 600 秒的运行时间）；如需恢复超时即终止的行为，将 `[background]` 的 [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) 设为 `false`。600 秒的默认后台超时可通过 [`bash_task_timeout_s`](../configuration/config-files.md#background) 配置（`0` = 无超时），且在 print 模式（`kiki -p`）下默认无超时。后台模式立即返回任务 ID，任务结束时自动通知 Agent。stdin 始终被关闭，交互式命令会立即收到 EOF。任务被停止或后台超时时采用两阶段终止策略（SIGTERM → 5 秒宽限期 → SIGKILL），确保进程可靠结束。Windows 平台默认使用 Git Bash。

## 网络类

两个工具都由 Kiki 内置的搜索与抓取模块支撑，该模块随产品一起安装，不需要额外的安装步骤。模块的 provider 实例、凭证槽、lane 和默认 fetch chain 都已内置：网页搜索只要配置好可用的 lane 即可工作，抓取则直接使用内置默认链。配置入口见 [`nb_search`](../configuration/config-files.md#nb-search)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `WebSearch` | 自动放行 | 网络搜索 |
| `FetchURL` | 自动放行 | 获取指定 URL 的内容 |

### `WebSearch`

通过 Kiki 内置的 `nb-search` 模块进行搜索。最小调用为 `{ "query": "搜索词" }`，对应 `action: "run"`，其余字段沿用 `[nb_search]` 默认值。`query` 可以是单个字符串或字符串数组。

若 `[nb_search.defaults]` 中没有配置默认 `search_lane`，且调用里也未通过 `lane`、`lanes` 或 `preset` 显式选择，工具会提示当前没有可用的搜索 lane，需要明确指定已配置的 lane 或 preset 才能继续执行。显式的 lane、`lanes` 列表或 preset 会覆盖配置默认值；选择无效或不可用时直接报错，不会悄悄换成其他 provider。

`run` 接受以下几组真正影响行为的参数：

- `lane`、`lanes`、`preset` — 三者互斥，只能选其一。用 `lanes` 或 `preset` 合并排序结果；要得到 typed 结果必须只指定单个 `lane`。
- `freshness`、`max_results` — 内容筛选。
- `timeout_ms` — 单次调用超时。
- `execution`、`idempotency_key` — 见下文的异步小节。

结果可能是排序后的链接/摘要，也可能是 typed 的研究/文档回答。provider 的输出不是独立验证——引用时给出实际 URL，需要原文时改用 `FetchURL`。

```json
{ "query": "kimi-code release notes" }
```

```json
{ "query": "kimi-code 架构", "lane": "<你配置的 lane 名>", "execution": "sync" }
```

### `FetchURL`

通过 Kiki 内置的 `nb-search` 模块抓取或抽取内容。最小调用为 `{ "url": "https://example.com" }`，对应 `action: "run"` 的 URL 简写；不要把简写 `url` 与 `source` 形式混用。默认 fetch chain 返回 Markdown；HTML 响应被抽取为正文文本，纯文本或 Markdown 页面则直接透传。

`run` 接受以下几组真正影响行为的参数：

- `source` — `kind: "url"` 取远程页面，`kind: "inline_text"` 或 `kind: "inline_bytes"` 表示内容已在调用里，或 `kind: "file"` 表示已配置 file 域内的某个路径。
- `pipeline`、`representation` — 覆盖默认 fetch chain。
- `timeout_ms`、`max_content_chars` — 上限。
- `execution`、`idempotency_key` — 见下文的异步小节。

工具会报告抓取结果及内容截断情况。结构化结果中的操作状态与文档元数据分别描述执行结果和内容完整性；最小调用则用可读文本提示。引用时注明截断或部分结果，不把它当作完整原文，并给出实际来源 URL。

URL 简写与 `source` 形式接受同样的选项。inline 与 file 内容不能送入 egress pipeline；不支持的 source/pipeline/mode 组合返回错误而非静默替换。

```json
{ "url": "https://example.com/docs" }
```

```json
{ "action": "run", "source": { "kind": "url", "url": "https://example.com/long" }, "execution": "async", "idempotency_key": "fetch-long-1" }
```

#### 异步运行与 job_id 操作

两个工具共用同一套执行模型：

- 执行默认**同步**。把 `execution: "async"` 与 `idempotency_key` 一起传入即可启动后台 job；同步调用不得包含 `idempotency_key`。
- 异步调用返回的是 job receipt，而非 Kiki 后台任务。重新提交同一 `idempotency_key` 即视为同一请求。
- 用同一工具的 `action: "get"`、`"read"`、`"cancel"` 配合 `job_id` 跟进一个 job。
- `read` 返回该 job 的 artifact chunk，字段为 `data_base64`，附带字节偏移与可选的 `page_size` / cursor 分页 / `next_cursor`。这些并非纯文本页面内容；按 schema 报告的编码自行解码。
- 遵循 `poll_after_ms` 节奏，避免忙等轮询；已完成的 job 中仍可能包含部分操作结果。

#### `FetchURL` 的 file 来源

`source.kind: "file"` 需要在 `[nb_search.fetch.file_scopes]` 中先配置域，给出该域内的相对路径，并由 Kiki 完成文件系统/路径准入。准入在调用时一次性绑定规范路径与文件对象标识；执行时 worker 从同一标识读取，因此对文件原地修改可见。原子替换或文件对象变更会被拒绝——请重新发起一次工具调用以获得新的审批，而不是重试旧 job。无法提供可用文件标识的文件系统会报错；已配置的域并不授予任意主机文件访问，也不会绕过敏感文件保护。

```json
{ "action": "run", "source": { "kind": "file", "scope": "<你配置的 file 域>", "path": "design/notes.md" } }
```

## Plan 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterPlanMode` | 自动放行 | 进入 Plan 模式 |
| `ExitPlanMode` | 自动放行（需用户确认计划） | 退出 Plan 模式并提交计划 |

Plan 模式下，`Write` 与 `Edit` 只能修改当前计划文件。`BoardWrite`、`TaskStop`、`CronCreate`、`CronDelete`、`AgentSend`，以及通过 `AgentRun` 恢复已有子 Agent 的操作均被拦截（`BoardWrite` 的细节见[状态管理](#状态管理)）。

新的 `AgentRun` 调用可以使用原生执行器创建研究子 Agent。这些子 Agent 只能使用其 profile 和既有策略允许的内置 `Read`、`ReadMediaFile`、`Glob`、`Grep`、`WebSearch`、`FetchURL`，不能运行 `Bash`、调用 MCP 或用户自定义工具，也不能继续派遣任务。此类调用不支持外部执行器。退出 Plan 模式或恢复会话后，研究子 Agent 仍保留只读限制；需要写入权限来实施时，应在退出 Plan 模式后创建新的子 Agent。

父 Agent 的 `Bash` 调用仍按当前权限规则处理。进入 Plan 模式不会停止此前已启动的后台工作，也不提供系统级沙箱隔离。

**`EnterPlanMode`** 不接受任何参数，进入成功后返回工作流指引及计划文件路径。

**`ExitPlanMode`** 读取当前计划文件内容，将计划呈现给用户审批后退出 Plan 模式。可选参数 `options` 允许 Agent 提供 1–3 个备选方案（每项含 `label` 与 `description`，`label` 最长 80 字符），供用户在审批时选择；`label` 不能重复，也不能使用 `Approve`、`Reject`、`Reject and Exit`、`Revise` 等保留词。

## 状态管理

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TodoList` | 自动放行 | 管理任务待办列表 |
| `BoardRead` | 自动放行 | 读取工作区任务看板上持久化的需求卡 |
| `BoardWrite` | 需审批 | 在工作区任务看板上创建或更新持久化的需求卡 |

**`TodoList`** 是 Agent 自己的执行清单。主 Agent 与各子 Agent 的清单相互独立，工具不能读取或修改其他 Agent 的清单。`todos` 参数接受一个数组，每项含 `title` 和 `status`（`pending` / `in_progress` / `done`）；省略 `todos` 仅查询调用者的当前清单，传入空数组也只清空该清单。清单随所属 Agent 恢复，会话撤销只回滚该 Agent 的清单；提醒与压缩摘要同样使用接收方自己的清单。历史共享清单仍归主 Agent，不从旧工具消息推测并重建各子 Agent 的历史清单。

任务看板是跨会话持久化的需求记录。`BoardRead` 支持 `preview` / `list` / `show` / `overview`，可查看当前工作区或其他已授权工作区中的卡。`BoardWrite` 的 `create` 始终以 `active` 开始，因此不要传 `status`；`update` 只有在改状态时才显式传 `status`。允许的状态值包括 `active`、`in_progress`、`paused`、`done`、`cancelled` 和 `superseded`；`done`、`cancelled`、`superseded` 是终态，将 `status` 改回 `active`、`in_progress` 或 `paused` 即可重开，重开会清空 `completedAt`。修改必须使用卡片当前的 `revision`；发生冲突后，重新读取卡片再重试。

卡是持久化需求记录，不是 Agent 运行，也不是每个 Agent 自己的 `TodoList`。读卡不会改卡；各 Agent 的 `TodoList` 相互独立；Todo 全部 `done` 也不会自动改卡。两个工具默认只提供给主 Agent，并受 `task_board` 实验开关控制。原生 subagent 默认不能使用这两个工具；可通过其 profile 的 `tools` 列表或 [`subagent.allowed_tools`](../configuration/config-files.md#subagent) 显式允许其中任一工具，但不会绕过其他工具限制。Plan 模式下可以用 `BoardRead` 读取，但 `BoardWrite` 会在审批前直接拒绝（见[Plan 模式](#plan-模式)）。写卡遵循普通权限策略，不额外要求 workspace trust（工作区信任）。

在「设置 → 计划与任务」中选择 `auto`、`global` 或 `fixed` 存储方式。固定位置可以是绝对路径，也可以是相对工作区的路径；不会执行脚本。任务看板为内置功能，无需单独安装。选择 `auto` 时，优先复用项目已有的兼容存储，否则使用会话数据区。

## 协作类

主 Agent 默认提供 4 个 peer thread 工具：`ThreadList`、`ThreadRead`、`ThreadSend` 和 `ThreadWait`。这些工具通过主机/工作区/会话引用访问同一台本地主机上的现有会话，工具输入中的字段名为 `host_id`、`workspace_id` 与 `session_id`。子 Agent 不提供这些工具。

- `ThreadList` 按更新时间从新到旧列出已启用且未归档的会话，也可以用 `workspace_id` 筛选。`limit` 默认为 50，取值为 1–100；还有下一页时会返回不透明 cursor。
- `ThreadRead` 读取已完成的主 Agent turn，不会恢复冷会话。参数包括 thread 引用与可选 cursor；`limit` 默认为 20，取值为 1–100。
- `ThreadSend` 持久接收发往另一条 thread 的消息，并从当前主 Agent 会话记录 peer 来源。传入目标 thread、非空且最多 100,000 字符的 `content`，以及非空且最多 256 字符的 `idempotency_key`；它没有来源参数，同一个 key 只能用于同一条消息。
- `ThreadWait` 等待 terminal、attention、lifecycle 或消息无法投递活动。单次可等待 1–8 条互不重复的 thread；`timeout_ms` 默认为 30,000，取值为 0–60,000。

Peer thread 通信只能在同一台主机内进行，可以跨工作区，并受 [`[thread_communication] enabled`](../configuration/config-files.md#thread-communication) 全局控制。持久化的单工作区覆盖值也可以关闭某个工作区。

只有来源 thread 的主 Agent 调用 `ThreadSend` 才会记录 peer 归属；REST 与 Klient 发送属于只指定目标的 user 来源输入。详见 [Agent 与子 Agent](../customization/agents.md#peer-thread-通信)。

Kiki 桌面端和 `kiki` CLI/TUI 会给主 `agent` profile 始终提供 `AgentRun`、`AgentList` 和 `AgentSend`。这些工具只管理调用方的直属子 Agent——用 `AgentRun` 里可选的 `name`，或用 agent id。它们不需要实验开关。内置的 [`coder` 与 `explore` profile](../customization/agents.md) 没有这组工具。已退役的 `AgentSwarm` 可调用工具不再支持新调用；历史 swarm 子 Agent 记录仍可读取。

`AgentList` 返回这些直属子 Agent，包括保留的历史 swarm 条目，不会列出孙级。`AgentSend` 的投递语义是尽早送达：子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn；子 Agent 空闲（或竞态恰逢 turn 结束）时保持排队，到下一步开始时才读这条消息。
协作类工具负责 Agent 间协作、用户交互和 Skill 调用。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `AgentRun` | 自动放行 | 派生 subagent 执行子任务，或继续一个直属子 Agent |
| `AgentList` | 自动放行 | 列出调用方的直属子 Agent |
| `AgentSend` | 自动放行 | 尽早向直属子 Agent 送达一条邮箱消息，运行中会被 steer 进活跃 turn |
| `AskUserQuestion` | 自动放行 | 向用户提问以获取结构化输入 |
| `Skill` | 自动放行 | 调用已注册的 inline Skill |

**`AgentRun`** 将子任务委托给子 Agent。必填参数为 `prompt` 和 `description`（3–5 个词的短任务描述，用于界面展示）。可选启动参数包括 `profile`（默认 `coder`）、`profile_file`（显式 role Markdown 文件，绝对路径或工作区相对路径；它是 role 定义而非共享提示词模板，与 `profile`、`route`、`resume` 互斥）、`background`（默认 `false`）、`name`（会话内唯一的句柄，只含小写字母、数字和下划线，`root` 保留）、`route`、`model_alias`、`effort`，以及在 `resume` 时显式修改模型用的 `allow_model_change`。新派生项的模型来自 `model_alias` 参数或生效 profile / route / caller lease 上的 pin，参数优先；两者都没有时调用以 `model.not_configured` 失败，不会创建子 Agent。effort 独立解析：工具 `effort` → profile `thinking_effort` → 所绑定模型自身的默认档位。显式传入未知 `model_alias` 时会报错。`resume` 按名称或 agent id 继续已有直属子 Agent，与 `name`、`profile`、`profile_file` 和 `route` 互斥。省略 `effort` 会保留已保存的 effort，也可以传入让下一次空闲运行使用。省略 `model_alias` 会保留已保存的模型；切换到不同规范模型必须传 `allow_model_change: true`，而解析到同一规范模型则不产生变化。Role 模型 / effort 指引与 route / caller lease pin 对可执行绑定只产生 advisory，并会出现在 `AgentRun` 回执中；机器级模型 deny、不可用能力、换模确认，以及 executor / thread 限制仍是硬错误。外部 executor 不支持修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。Agent 任务默认 2 小时超时，通过 `[subagent] timeout_ms` 或 `KIKI_SUBAGENT_TIMEOUT_MS` 配置全局限制（`0` 表示禁用），print 模式默认无超时；不提供单次调用 timeout 或任意供应商参数透传。前台模式下父 Agent 等待结果；后台模式立即返回任务 ID，结果会通过之后的合成 User 消息自动送达。TUI 会把同一步中的多个前台调用合并展示，并显示状态与耗时。完整 profile 与生命周期契约见 [Agent 与子 Agent](../customization/agents.md)。

**`AgentList`** 列出当前 Agent 的直属子 Agent。可选参数 `include_finished` 默认为 false。实例正在启动、运行或取消时，即使之前的后台任务已完成或超时，也会以 `running` 保持可见。执行器处于故障状态时显示 `errored`；其他情况采用最近一次后台任务状态，没有任务记录则为 `untracked`。传 `true` 才会额外包含已结束或出错的子 Agent。最多返回 50 条，运行中的排在前面；装不下的数量记在 `omitted`。每条记录含 `agent_id`、可选的 `name` 与 `profile`、`status`，以及保留的历史 swarm 子 Agent 有 item 标签时才会出现的 `swarm_item`。`running` 不代表一定有跟踪中的后台任务或之后的完成通知；用 `TaskList` 查看跟踪中的工作。

**`AgentSend`** 把非空的 `message` 排进直属子 Agent 的邮箱。`target` 可以是 `AgentRun` 当时传入的 `name`，也可以是 agent id。子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn，尽早送达；空闲的子 Agent 不会被唤醒，消息等到下一次运行时才读。匹配到多个直属子 Agent、或一个都匹配不到时调用失败——先用 `AgentList` 再换成不含糊的值重试。邮箱满了说明未读排队消息太多，等子 Agent 消化一些再发。

**`AskUserQuestion`** 以结构化多选题的形式向用户提问，适用于需要消歧或选择方案的场景。`questions` 参数接受 1–4 道题，每道题需提供 `question`（以 `?` 结尾）、`options`（2–4 个选项，每项含 `label` 和 `description`）以及可选的 `header`（最多 12 字符）和 `multi_select`（默认 false）。系统自动附加"其他"选项。`background` 为 true 时启动后台问题任务并立即返回任务 ID。宿主未实现交互式提问能力时返回失败提示，Agent 应改为在文本回复中直接提问。

**`Skill`** 按已注册的 `skill` 名称或显式 Markdown `path` 加载指令，两者互斥，可附带 `args`。路径可以是绝对路径或工作区相对路径，遵循文件读取权限和运行时隔离。路径加载不会覆盖已注册 Skill、安装插件或执行脚本。相对资源仍以文件所在目录为根；加载块记录来源路径与参数，可区分同名文件。省略类型以及 `prompt`、`inline` 类型均受支持；模型不能调用 `flow` 类型或 `disableModelInvocation: true` 的 Skill，路径入口也不例外。嵌套调用深度上限 3 层。Skill 体系细节见 [Agent Skills](../customization/skills.md)。

## 后台任务

完成通知会直接附上较短的结果。同一模型步骤或同一轮恢复中的普通 Agent、进程输出预览共用 16,000 字节的 UTF-8 额度，按 XML 转义前的内容计算。额度耗尽时会明确标注预览已省略，仍保留任务身份、状态、失败信息，以及可用的完整输出路径。完整问题回答保留原有的内联行为，不占用这个预览池。该限制针对预览，不是整个通知的总长度。

后台任务工具用于管理通过 `Bash`、`AgentRun` 或 `AskUserQuestion` 启动的后台任务。任务进入终止状态时会自动把状态和已保存的输出路径送回 Agent。对于启用自动完成通知的后台子 Agent，交互主 Agent（root）继续处理独立工作；没有独立工作时正常结束当前轮次。任务完成后，通知会在 root 空闲时自动开启后续轮次，无需用户再次发送消息。结束轮次会保留运行中的任务和会话，也不表示整体任务已完成。

Root 不应为了等待该结果，使用 `TaskWait`、`TaskOutput` 或 `AgentList` 轮询、sleep 或定时循环维持当前轮次。`TaskOutput` 用于有具体目的的进度检查，`TaskWait` 用于确需在同一轮次同步获取结果的场景。自动通知不可用时，按任务的实际需要选择是否等待。子 Agent 仍须处理自己的依赖，再向父 Agent 返回最终结果。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TaskList` | 自动放行 | 列出后台任务 |
| `TaskOutput` | 自动放行 | 查看后台任务的输出 |
| `TaskStop` | 需审批 | 停止正在运行的后台任务 |
| `TaskWait` | 自动放行 | 等待后台任务结束 |

**`TaskList`** 返回后台任务列表。可选参数 `active_only`（默认 true，仅列出运行中的任务）和 `limit`（默认 20，取值范围 1–100）。

**`TaskOutput`** 根据 `task_id` 返回任务状态与输出。内联预览最多包含最近 32 KB 的内容；完整日志保存在磁盘上，工具会一并返回 `output_path` 并提示通过 `Read` 分页读取。该调用始终是非阻塞的——立即返回当前快照，任务完成会通过自动通知送达。

**`TaskStop`** 接受 `task_id` 和可选的 `reason`（默认 `Stopped by TaskStop`）。对已处于终止状态的任务也能安全调用。

**`TaskWait`** 用于显式同步等待，把当前轮次挂起，直到后台任务结束或超时。参数：`timeout`（必填，单位秒，范围 1–600）和可选的 `task_id`。不传 `task_id` 时，调用时刻运行中的任意一个后台任务结束即返回；当前没有运行中的后台任务时立即返回。超时不是错误：结果会列出仍在运行的任务，不会停止它们。此时应重新判断同轮同步需求，不要自动重复等待。已通过 `TaskWait` 汇报结果的任务不会再推送自动完成通知。

## 定时任务

定时任务工具允许 Agent 把一段 prompt 在未来某个时间重新注入到当前会话——既可以是一次性提醒，也可以是按 cron 周期触发的任务（定期巡检、每日报表、部署监控等）。计划绑定到会话，用 `kiki --session` 恢复会话后仍然有效，但不会带入全新的会话。单个会话最多保留 50 个生效中的定时任务。设置 `KIKI_DISABLE_CRON=1` 可整体禁用，详见[环境变量](../configuration/env-vars.md#运行时开关)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `CronCreate` | 需审批 | 安排一个在未来时刻触发的 prompt |
| `CronList` | 自动放行 | 列出已安排的定时任务 |
| `CronDelete` | 需审批 | 取消已安排的定时任务 |

**`CronCreate`** 接受 `cron`（用户本地时区下标准的 5 段 cron 表达式：`minute hour day-of-month month day-of-week`）、`prompt`（触发时要注入的文本，UTF-8 上限 8 KB）以及可选的 `recurring`（默认 `true`；传 `false` 表示一次性提醒，触发后自动删除）。成功时返回 8 位 16 进制 `id`、人类可读的 `humanSchedule`（如 `every 5 minutes`）和 `nextFireAt`（下次触发时间的 ISO 时间戳）。

为避免整批用户在整点同时触发，调度器会做确定性抖动：周期任务向后偏移 `min(周期的 10%, 15 分钟)`；一次性任务若恰好落在 `:00` 或 `:30` 则向前提前最多 90 秒。如果调度器错过了若干触发时刻（如笔记本合盖），唤醒后只会触发一次，prompt 会包裹在 `<cron-fire>` 信封里并附带 `coalescedCount`。周期任务存活超过 7 天后会以 `stale="true"` 做最后一次触发后自动删除；想继续保留时，再次调用 `CronCreate` 即可。

**`CronList`** 是只读工具，不接受任何参数。为每个生效中的任务返回一条记录，字段包括 `id`、`cron`、`humanSchedule`、`nextFireAt`、`recurring`、`ageDays` 和 `stale`。记录用 `---` 分隔，按调度时间排列。

**`CronDelete`** 只接受一个 `id`。对周期任务，未来所有触发立即停止；对一次性任务，挂起的那次触发会被取消。已触发的一次性任务会自动删除，因此对已触发过的一次性任务调用 `CronDelete` 会返回 `No cron job with id ...`。删除不可撤销，需要还原时只能再次 `CronCreate`。`CronDelete` 在 Plan 模式下同样会被拦截。

## 下一步

- [Agent 与 subagent](../customization/agents.md) — `AgentRun` 工具的调度机制与上下文隔离
- [Hooks](../customization/hooks.md) — 在工具调用前后触发本地脚本
- [斜杠命令](./slash-commands.md) — TUI 内置控制命令速查
