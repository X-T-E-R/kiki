# 内置工具

内置工具是 Kiki 随核心引擎提供的工具集，无需安装 MCP server 即可使用。Agent 在每次对话中会根据任务需要自动选择并调用这些工具；用户可以通过权限审批界面查看每次工具调用的细节。

与 MCP 工具相比，内置工具由运行时直接管理，生命周期与会话绑定，无需外部进程。两者都遵循统一的审批机制：**只读类工具**（如 `Read`、`Grep`、`Glob`）默认自动放行，**执行类工具**（如 `Bash`）默认需要用户审批。文件写入遵循工作区信任模型：在已信任的工作目录内，落在该目录下的 `Write` / `Edit` 不再逐项询问；实际目标在工作区外的写入需要审批。敏感性按符号链接解析后的实际目标判断：manual 与 Auto 模式请求审批，YOLO 模式免询问放行，但显式 deny 规则仍优先。Plan 模式下的退出审批不受影响。

## 文件类

文件类工具负责读取、写入、搜索本地文件系统，是代码分析和修改任务的基础工具。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Read` | 自动放行 | 读取文本文件内容 |
| `Write` | 受信任工作区内自动放行；工作区外拦截或需审批 | 创建或覆盖文件 |
| `Edit` | 受信任工作区内自动放行；工作区外拦截或需审批 | 精确字符串替换 |
| `Grep` | 自动放行 | 基于 ripgrep 的全文搜索 |
| `Glob` | 自动放行 | 按 glob 模式查找文件 |
| `ReadMediaFile` | 自动放行 | 读取图片或视频文件 |

**`Read`** 接受文件路径（`path`）以及可选的 `line_offset`（起始行号，支持负数从末尾倒数）和 `n_lines`（读取行数上限）。单次最多返回 1000 行或 100 KB，超出部分会附带截断提示。支持 UTF-8 和 UTF-16 文本，UTF-16 会转换后展示。结果附有行号和原始行尾信息；纯 CRLF 文件在 `Read` 中显示为 LF，`Edit` 按该视图替换时仍保留 CRLF；混合行尾需要精确匹配展示出的 `\r` 字符。如果文件是图片或视频，工具会提示改用 `ReadMediaFile`。显式绝对路径可读取工作区外文件，但敏感目标仍需按权限模式处理。已登记的用户 Skill / Agent 定义根（包括符号链接安装）默认可读；普通工作区中指向外部目标的链接仍需审批。`~/.kiki` 中只有 `agents`、`skills`、`commands`、`docs` 是定义或文档读取根；其余文件须指定明确路径，并遵守敏感文件规则。

**`Write`** 接受 `path`、`content` 和可选的 `mode`（`overwrite` 或 `append`，默认覆盖）。缺失的父目录会自动创建；`append` 模式将内容追加到文件末尾，不自动添加换行。

**`Edit`** 接受 `path`、`old_string`（要替换的精确文本）和 `new_string`（替换后的文本）。默认只替换唯一一处匹配，若文件中存在多处相同内容会报错并提示使用 `replace_all: true`。`old_string` 与 `new_string` 不能相同。`Write` 与 `Edit` 在审批前解析符号链接：链接位于 Skill 目录不等于已获准写入其目标。审批后若目标发生变化，请重新检查目标并重试调用。

**`Grep`** 调用 ripgrep 搜索文件内容，支持正则表达式（`pattern`）、搜索路径（`path`）、文件类型过滤（`type`，如 `ts`、`py`）、glob 过滤（`glob`）和输出模式（`output_mode`：`files_with_matches` / `content` / `count_matches`，默认 `files_with_matches`）。`content` 模式支持上下文行（`-A`、`-B`、`-C`）、忽略大小写（`-i`）、行号（`-n`，默认 true）、跨行匹配（`multiline`）。所有模式支持 `offset` + `head_limit` 分页，`head_limit` 默认 250、传 0 表示不限。`.env`、私钥等敏感文件会被自动过滤；`include_ignored=true` 可搜索被 `.gitignore` 忽略的文件，但敏感文件仍保持过滤。

**`Glob`** 按 glob 模式（`pattern`）在指定目录（`path`，默认工作目录）中匹配文件，结果按修改时间倒序排列，默认返回 100 条。默认尊重 `.gitignore`、`.ignore` 和 `.rgignore`；设置 `include_ignored=true` 可包含构建产物等被忽略的文件，但敏感文件仍会被过滤。支持 `*.{ts,tsx}` 这类花括号模式，也允许宽泛通配符模式。

使用 `offset`（默认 0）和 `head_limit`（默认 100）对匹配路径分页；有更多结果时，工具会给出下一页的 offset。设置 `head_limit: 0` 可取消条数限制，但字符上限仍然有效：达到上限时，页面会在完整路径处结束，并给出下一页的 offset。较大的页面会保存到文件，Agent 可用 `Read` 读取。每次调用都会重新搜索当前文件系统，因此文件变化可能导致跨页结果移动。超时、目录无法读取或输出采集上限仍可能造成搜索不完整；结果会提示这些情况，增加 offset 无法恢复尚未收集的路径。

**`ReadMediaFile`** 将图片或视频以多模态内容发送给模型。它接受 `path`，以及 `region`、`full_resolution` 等可选的图片细节参数；文件大小上限为 100 MB。默认读图会按配置的模型限制压缩；如果自动压缩无法安全满足限制，工具会返回错误且不发送原图，并提示模型先创建更小的副本再读取。是否可用取决于当前模型的视觉能力（`image_in` / `video_in`）。

## Shell

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Bash` | 需审批 | 执行 Shell 命令 |

**`Bash`** 是权限要求最严格的工具，也是功能最通用的工具。参数模式和复合命令的检查方式见[权限规则](../configuration/config-files.md#permission)；可以使用 `kiki permission test 'Bash(...)'` 检查规则而不执行命令。参数：

- `command`（必填）：要执行的 Shell 命令
- `cwd`：工作目录。本地运行时中，Agent 当前有效权限模式为 YOLO 时，可显式指定工作区外的绝对路径；放行不会越过 Agent 权限上限或真实远程/容器隔离。manual/auto 模式及相对路径越界仍受原有工作区边界约束。
- `timeout`：超时时间（毫秒）；前台默认 60 秒、最长 5 分钟
- `run_in_background`：是否以后台任务运行；后台默认 10 分钟超时（print 模式 `kiki -p` 下默认无超时）
- `description`：后台任务描述，`run_in_background=true` 时必填
- `disable_timeout`：后台任务是否取消超时限制

如果命令只是在读文件、搜索文件或写文本文件，`Bash` 仍照常执行，但结果末尾可能附一行提示，指向 `Read`、`Grep`/`Glob` 或 `Write`/`Edit`。每类提示在一个会话中最多出现三次；在 [`[background]`](../configuration/config-files.md#background) 下设置 `bash_file_tool_hints = false` 可关闭提示，不改变执行与审批行为。

前台模式会阻塞当前轮次，直到命令结束或超时；命令运行期间，TUI 会把 stdout 和 stderr 流式显示在正在运行的 `Bash` 工具卡片中。前台命令超时后默认不会被终止，而是转为后台任务继续运行（受 600 秒默认后台超时约束，即超时转入后台的命令会重新获得最多 600 秒的运行时间）；如需恢复超时即终止的行为，将 `[background]` 的 [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) 设为 `false`。600 秒的默认后台超时可通过 [`bash_task_timeout_s`](../configuration/config-files.md#background) 配置（`0` = 无超时），且在 print 模式（`kiki -p`）下默认无超时。后台模式立即返回任务 ID，任务结束时自动通知 Agent。stdin 始终被关闭，交互式命令会立即收到 EOF。任务被停止或后台超时时采用两阶段终止策略（SIGTERM → 5 秒宽限期 → SIGKILL），确保进程可靠结束。Windows 平台默认使用 Git Bash。

## 动态工具

MCP 和插件工具会以名称和简短说明公告。需要调用时，先用 `SelectTools` 选择公告中的名称；模型会在下一步收到该工具的 schema。已列在工具列表中的普通工具可直接调用。Kimi provider 在消息内携带所选工具的 schema；OpenAI chat、OpenAI Responses 和 Anthropic provider 在 system 文本中携带 schema，只要还有延迟工具可用，就在顶层工具列表提供稳定的 `CallTool` 桥接工具。模型也可以直接用真实名称调用已加载工具。审批、访问检查和界面工具卡片都使用真实工具名。模型具备工具调用能力时，这些 provider 默认启用 `tool-select`；不要求声明 `dynamically_loaded_tools`。关闭该 flag 会恢复内联工具提供方式。

如果当前没有延迟的 MCP 或插件工具，工具列表不会出现 `SelectTools` 或 `CallTool`。仍有延迟工具可用时，MCP server 重连或插件装卸只改变增量公告，不改变顶层工具列表。profile 目录变化时，仅当当前 Agent 实际可派遣的 profile 新增、移除或发生变化，才会在下一条用户消息时公告。用户主动修改工具组、MCP server 或记忆配置，则从下一条用户消息开始应用，顶层工具列表可能变化。

## 历史工具

`HistorySearch`、`HistoryRead` 和 `HistoryList` 是 `history` 工具组中的常驻内置工具。启用后，它们会直接出现在工具列表中，无需使用 `SelectTools`。它们按照既有工作区访问权限读取会话原文；来源 `ref` 是证据位置，不授予额外权限。

**从旧版 Search 默认值迁移：**`HistorySearch({"query":"有辨识度的词"})` 现在默认以 `mode: "auto"`（完整词组匹配）搜索当前会话、当前 Agent；此前默认在整个工作区进行词元 AND 检索。仍持有旧工具描述的窗口也执行新默认值，执行契约不会按模型见过的 schema 版本锁定。每次 Search 都返回 `scope_used`、`mode_used` 和 `target`。会话范围内的结果少于 `limit` 时，`expand_hint.next_call` 给出可直接调用的 `scope: "workspace"` 扩大范围方案；对 auto/all/any 会明确切换到索引支持的 `mode: "terms"`（词元 AND），返回值会回显这一模式变化。需要明确保留旧检索方式时，传 `{"scope":"workspace","mode":"terms"}`；`scope: "this_session"` 仍是锁定当前会话的兼容别名。搜索已知旧会话须显式给 `session_id`；扩大 Agent 范围须指定 `agent_id` 或 `include_subagents`。检查 `coverage` 和 `next_cursor`：空结果且状态为 partial 表示已扫描或已索引范围尚未覆盖完整。扫描 cursor 续接有界片段；cursor 过期后重新发起原查询。

在服务端的 transcript 回退检索中，`sort: "newest"` 和 `"oldest"` 按时间戳排列命中文本，跨页用稳定来源 ID 处理同时间命中；缺失的时间戳按零排序。导航先构建到固定来源水位，确认当前可见性，因此冷态大会话可能先返回空的 `navigation_building` 准备页，再返回命中。用 `next_cursor` 继续；投影准备和原文读取共享每次调用的预算。导航就绪后，最新优先检索会直接读取近期文本片段，不再从 wire 开头扫起。

默认的 `sort: "relevance"` 只在当前有界页收集到的命中之间按词法得分排序：完整查询命中和更多词组命中提高分值，再以较新时间戳和稳定 ID 打破平分。跨页按最新时间优先扫描，并非全局相关度排序；后续页可能有更相关的命中。部分页会在 coverage 中披露 `page_local_relevance`。新版扫描 cursor 绑定查询、来源指纹和导航 generation；来源追加、undo、clear 或改写都会使其失效，失效后应重新发起查询。旧版扫描 cursor 仍能按来源顺序续扫，但会提示重新查询以使用排序导航。

省略新版的 scope 和 mode 参数时，会按当前 session 和 `auto` 模式处理。不要假定旧版默认值，请读取响应中的 `scope_used` 和 `mode_used`；如果结果范围太窄，按 `expand_hint.next_call` 的建议改用 `scope: "workspace"` 重试。

不知道关键词时，用 `HistoryList` 浏览短轮次摘录或旧会话的 Agent 目录。轮次条目的 `ref` 传给 `HistoryRead` 会按来源 block 读取整轮；也可用 `turn` 或 `step_id` 选择有界的轮次、步骤 block。导航目录尚在构建时，coverage 会披露已扫描范围。已知步骤可用 `HistoryRead({"step_id":"t42.3"})`。Search 命中文本块时，`HistoryRead({"ref":"<hit.ref>"})` 从命中附近开始读。每个 block 返回自己的 `ref` 和 UTF-16 `range`；用 `cursor` 续读，若 cursor 失效，可用 block 的 `ref` 加上一次的 `range.end` 作为 `start_char` 重开。来源撤销或失效会明确报错，不会跳到同号的新轮次。已有的 v1 Read cursor 仍按旧 JSON 形式续页；用 ref、turn 或 step_id 重新发起可切换到 blocks。

只检索跨线程消息时，使用 `HistorySearch({"query":"交接","scope":"peer"})`。它搜索当前工作区内的双向往来，也可指定经批准访问的 `workspace_id`；可选 `session_id` 限定一个会话。Peer 检索复用既有词法匹配模式，但始终按最新时间优先排列：省略 `sort` 或使用 `"newest"`。它排除子 Agent 和普通用户输入，不接受 `source: "transcript"`；指定 Agent 时只接受 `agent_id: "main"`。结果来源为 `source: "mailbox"`，命中带有 `communication` 元数据，包含消息身份、两端和投递状态，不会编造会话轮次号或 HistoryRead ref。完整正文和导航身份见[沟通记录 REST 读取](../server/rest-api.md#沟通记录)。部分页或空页应使用 `next_cursor` 继续读取；此视图覆盖邮箱仍保留的记录，不包含旧版本已淘汰的更早消息。

在非交互提示词运行（`kiki -p`）中，`HistoryList` 读取持久化对话记录的有界前缀，不启动服务器或搜索 worker：最多 2 MiB、10,000 条记录，每条记录最多 256 KiB；Agent 目录最多检查 256 个目录项。结果会明确报告 `partial` 覆盖，且不包含导航 `ref`。可以列当前会话，也可以显式指定另一个持久化会话的 `session_id`。这个 print host 中的 `HistorySearch` 和 `HistoryRead` 仍不可用；索引检索与完整历史读取请使用交互式会话或服务器。

## 网络类

两个工具都由 Kiki 内置的搜索与抓取模块支撑，随产品一起安装，不需要额外的安装步骤。免密钥的仓库搜索 lane 和 URL 抓取链无需配置即可使用；通用网页搜索需选择其他 lane。配置入口见 [`nb_search`](../configuration/config-files.md#nb-search)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `WebSearch` | 自动放行 | 网络搜索 |
| `FetchURL` | 自动放行 | 获取指定 URL 的内容 |

### `WebSearch`

通过 Kiki 内置的 `nb-search` 模块进行搜索。最小调用为 `{ "query": "搜索词" }`，对应 `action: "run"`，其余字段沿用 `[nb_search]` 默认值。`query` 可以是单个字符串或字符串数组。

零配置下，默认使用 `github.repositories`，只检索 GitHub 仓库，而非全网。查阅库文档请显式选择 `context7.docs`（返回 typed 结果）；免密钥通用网页检索可显式选择 `duckduckgo.search`，但公共 HTML 端点可能触发 CAPTCHA。需要可靠的通用检索时，建议配置 `exa.search` 等提供商。若显式删除默认 lane，且调用时未指定 `lane`、`lanes` 或 `preset`，工具仍会拒绝运行；显式选择会覆盖默认值，选择无效或不可用时也不会悄悄换成其他 provider。

`run` 接受以下几组真正影响行为的参数：

- `lane`、`lanes`、`preset` — 三者互斥，只能选其一。用 `lanes` 或 `preset` 合并排序结果；要得到 typed 结果必须只指定单个 `lane`。
- `freshness`、`max_results` — 内容筛选。
- `timeout_ms` — 单次调用超时。
- `execution`、`idempotency_key` — 见下文的异步小节。

结果可能是排序后的链接/摘要，也可能是 typed 的研究/文档回答。provider 的输出不是独立验证——引用时给出实际 URL，需要原文时改用 `FetchURL`。

配置多个密钥后，同一服务器上的同步 `WebSearch` 和 `FetchURL` 调用会跨调用、跨会话共享轮转和冷却状态；脱离进程的异步作业各自建立独立调度器。密钥格式、配置项及原有单密钥兼容方式见 [`nb_search`](../configuration/config-files.md#nb-search)。

```json
{ "query": "kimi-code release notes" }
```

```json
{ "query": "kimi-code 架构", "lane": "<你配置的 lane 名>", "execution": "sync" }
```

### `FetchURL`

通过 Kiki 内置的 `nb-search` 模块抓取或抽取内容。最小调用为 `{ "url": "https://example.com" }`，对应 `action: "run"` 的 URL 简写；不要把简写 `url` 与 `source` 形式混用。URL 的免密钥默认链先尝试 `direct.fetch`，失败时用 `jina.reader` 抽取正文；直连成功但内容无用时，需显式配置质量规则才会回退。默认链返回 Markdown；HTML 响应被抽取为正文文本，纯文本或 Markdown 页面则直接透传。

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

## 浏览器类

浏览器工具只在 `native_browser` 实验开关打开时出现，它们通过 Kiki 服务机上随附的受管 agent-browser 后端驱动已保存的连接。设置页与各接法指向的目标见[浏览器控制](../guides/settings.md#浏览器控制)。

**`BrowserConnections`** 操作连接本身：`action: "list"`（默认）返回已保存的连接与新会话默认项，`"select"` 绑定本 Agent 要用的连接，`"status"` 与 `"check"` 读取运行状态，`"connect"` 与 `"disconnect"` 启动或附着、以及释放连接，`"tools"` 按需加载后端的页面操作。连接只按已保存的 id 指定，显示名称不会被解析成 id。省略 `browser` 时使用本 Agent 绑定的连接或新会话默认项，不会退回到猜测的或仅仅处于就绪状态的浏览器。

`"tools"` 只注册你点名的分组或工具名。每个已加载操作会成为名为 `browser__agent_browser_<名称>` 的工具，保留后端自己的 schema，并额外接受 `browser` 与 `browserTab`。快照返回的元素引用只在产生它的浏览器、标签和 frame 内有效，页面变化后需重新读取快照。浏览器安装、插件与跨会话管理类操作不作为页面工具提供。

**`BrowserTabs`** 管理一条连接内的目标：`list`、`open`、`window`、`select`、`close` 与 `frame`（`main` 回到顶层 frame）。目标使用后端的 CDP target ID，不是标签序号或标签名，这些工具也不会跟随用户的前台标签。切换标签或 frame、或重新连接后，元素引用需要重新读取快照。

结果会带上解析后的连接、运行会话、标签与 frame。由 Kiki 为该次调用命名的产物——截图、HAR、trace、profiler 输出或录制——在 20 MiB 以内会自动附到时间线；更大的文件留在执行主机上，需要通过现有文件通道取回。超时不代表动作已确认：重发之前先对同一目标重新观察。

取消工具调用时，如果取消在动作发出之前生效——仍处于队列中，或已找到目标但动作尚未发出——浏览器操作会停下。尚未发出的取消不会影响该连接，也不会关闭其它工作正在使用的浏览器。动作一旦发出，取消不会把它收回：调用仍会运行到结束，其结果依然生效，Kiki 也不会替你重放或重试。请读取实际结果，不要假设取消已经撤销了动作。

## Plan 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterPlanMode` | 自动放行 | 进入 Plan 模式 |
| `ExitPlanMode` | 自动放行（需用户确认计划） | 退出 Plan 模式并提交计划 |

Plan 模式下，`Write` 与 `Edit` 只能修改当前计划文件。`BoardWrite`、`TaskStop`、`Cron` 的 `create` 和 `delete` 操作、`AgentSend`，以及通过 `AgentRun` 恢复已有子 Agent 的操作均被拦截（`BoardWrite` 的细节见[状态管理](#状态管理)）。`EnterPlanMode` 与 `ExitPlanMode` 是常驻内置工具，在普通策略允许时始终可用。

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

**`TodoList`** 分别管理调用方 Agent 的执行清单和工作笔记，两者独立更新。省略 `todos` 就不改清单，省略 `notes` 就不改任何笔记；传入 `{}` 才读取两者。`todos` 数组会完整替换清单，每项含 `title` 和 `status`（`pending` / `in_progress` / `done`）；`todos: []` 只清空清单。

`notes` 只需提供发生变化的节：`goal`、`directives`、`decided`、`rejected`、`evidence`、`files`、`next` 和 `open`。每个字符串完整替换对应节，因此仍有效的条件和例外需要一起保留。未传的节不变，`""` 删除一节，`notes: null` 清空全部笔记，`notes: {}` 不改内容。每节上限为 1,500 字符，总计 7,500 字符；混合调用超限时，清单和笔记都不改。写入只返回简短回执，列明修改与清空范围、版本、字符数和待办状态计数，不全文回显笔记；需要当前内容时再传 `{}` 读取。

主 Agent 与各子 Agent 的清单和笔记相互独立，工具不能读取或修改其他 Agent 的状态。两者随所属 Agent 恢复，并遵循会话撤销。换窗保留已有笔记，摘要中的候选要求留待核对，不会自动写入。只有将接力摘要和人类输入与当前笔记、原始来源核对后，才用 `review_handoff: true` 确认已核对到本次工具调用；普通单节更新不会代替这项确认。超限候选完整保留在接力摘要中，并显示提示；未核对输入会继续传递。GUI 保留未知文本节的原字段名；更新无法读取时会显示提示并保留上次可读笔记，而非显示为空。历史共享清单仍归主 Agent，不从旧工具消息推测并重建各子 Agent 的历史清单。

任务看板是跨会话持久化的需求记录。`BoardRead` 支持 `preview` / `list` / `show` / `overview`，可查看当前工作区或其他已授权工作区中的卡。`BoardWrite` 的 `create` 始终以 `active` 开始，因此不要传 `status`；`update` 只有在改状态时才显式传 `status`。允许的状态值包括 `active`、`in_progress`、`paused`、`done`、`cancelled` 和 `superseded`；`done`、`cancelled`、`superseded` 是终态，将 `status` 改回 `active`、`in_progress` 或 `paused` 即可重开，重开会清空 `completedAt`。修改必须使用卡片当前的 `revision`；发生冲突后，重新读取卡片再重试。

卡是持久化需求记录，不是 Agent 运行，也不是每个 Agent 自己的 `TodoList`。读卡不会改卡；各 Agent 的 `TodoList` 相互独立；Todo 全部 `done` 也不会自动改卡。两个工具默认只提供给主 Agent，并受 `task_board` 实验开关控制。原生 subagent 默认不能使用这两个工具；可通过其 profile 的 `tools` 列表或 [`subagent.allowed_tools`](../configuration/config-files.md#subagent) 显式允许其中任一工具，但不会绕过其他工具限制。Plan 模式下可以用 `BoardRead` 读取，但 `BoardWrite` 会在审批前直接拒绝（见[Plan 模式](#plan-模式)）。写卡遵循普通权限策略，不额外要求 workspace trust（工作区信任）。

在「设置 → 任务」中选择 `auto`、`global` 或 `fixed` 存储方式。固定位置可以是绝对路径，也可以是相对工作区的路径；不会执行脚本。任务看板为内置功能，无需单独安装。选择 `auto` 时，优先复用项目已有的兼容存储，否则使用会话数据区。

## 记忆类

记忆存放的是会话留不住的东西。智能体用 `MemoryWrite` 保存长期事实，用 `MemorySearch` 和 `MemoryRead` 找回来，分三个范围：全局、某个工作区、某个角色。搜索支持部分词命中，也支持不加空格的中文短语。原生 subagent 默认就能用只读的 `MemorySearch` 和 `MemoryRead`；`MemoryWrite` 始终只给主智能体，无法通过白名单开放给 subagent。

当一条修改或归档提议留待审阅时，原条目在决定之前保持原有内容并继续生效。接受提议才会对原条目执行相应的修改或归档；丢弃只移除这条提议，原条目不受影响。如果原条目在提议之后已经变化，该决定会被拒绝，提议仍会保留，并提示你重新读取该条目。

三个范围的模型、审批收件箱、可撤销的改动历史和 `/memory` 页，见[记忆](../guides/memory.md)。

## 协作类

主 Agent 默认提供 5 个线程工具：`ThreadCreate`、`ThreadList`、`ThreadRead`、`ThreadSend` 和 `ThreadWait`。`ThreadCreate` 创建独立的顶层会话；另外 4 个工具通过 `host_id`、`workspace_id` 与 `session_id` 访问现有会话。`ThreadSend` 仍仅限主 Agent，但 subagent profile 可以显式开放 `ThreadCreate`、`ThreadList`、`ThreadRead` 和 `ThreadWait`（见 [`subagent`](../configuration/config-files.md#subagent)）。

省略 `host_id`、留空或设为 `"local"` 都表示执行 Agent 所属 home，不是 GUI 当前打开的空间。同 home 可以跨工作区通信；另一个本机或远端空间需要 owner 批准的单向 [thread bridge](./command.md#kiki-bridges)，使用返回的完整主机引用及 `bridge_id` 或 `connection_id`。不同 home 中相同 Session ID 仍是不同线程，GUI 浏览权限也不等于 bridge 权限。

- `ThreadCreate` 仅在用户明确要求新建线程或会话时使用，不能用于常规委派。可选 `cwd` 必须是已存在目录的绝对路径，可以在当前工作区之外；省略时采用当前会话的工作区根目录。可选 `profile` 必须是已启用的主 Agent profile；省略时使用默认主 Agent。可选 `prompt` 最多 100,000 字符，会作为新线程的首条用户消息立即启动；省略时保持空会话，等待用户输入。可选 `title` 优先于自动标题；省略时若提供了 `prompt`，取首行前 80 个字符作为标题，否则沿用会话的默认名称。结果返回 `id`、`title`、`cwd`、`profile` 和 `prompt_started`。新线程几秒内会出现在左侧会话列表中；之后可用 `ThreadSend` 和 `ThreadWait` 继续交互。
- `ThreadList` 列出已启用且未归档的会话，可用 `workspace_id` 筛选。不选 bridge 时列执行 home，选定 bridge 时仅列批准的目标范围，需要 `read`。本地结果按更新时间从新到旧排列。`limit` 默认为 50，取值为 1–100；用返回的不透明 cursor 继续翻页。
- `ThreadRead` 在本地读取已完成的主 Agent turn，不恢复冷会话。跨 bridge 需要 `read`，返回有界的 `view.transcript`、coverage 和 cursor；省略的正文或 frame 带 `contentRefs`。将返回的引用作为 `content_ref` 传入，可读取下一段有界 `view.segment`。`limit` 默认为 20，取值为 1–100。
- `ThreadSend` 持久保存显式消息，执行中的主 Agent 会话作为已验证来源。传入目标、非空且最多 100,000 字符的 `content`，以及最多 256 字符的 `idempotency_key`。没有来源参数，同一个 key 只能用于同一条消息。Bridge 需要 `send`，投递到模型 prompt 或恢复冷线程还需 `wake`；没有 wake 时保持 pending。`delivered` 仅确认 prompt 投递，不代表已回复。Pending 使用原 key 最多重试 15 分钟，拒绝原因可查看 bridge receipts。普通 Assistant 正文不会自动转发。
- `ThreadSend({ room, content, mentions? })` 在当前线程已加入的房间发言。房间正文最多 20,000 字符，mentions 使用线程会话 ID 或角色 ID，省略重试键时使用工具调用 ID。只有显式房间发送才进入日志，普通 Assistant 文本不会入群。房间发送的 `delivered` 表示已记入日志，不表示所有成员已经回复；线程成员默认忙时排队。
- `ThreadWait` 等待 1–8 条互不重复的本地或已批准 bridge 线程的 terminal、attention、lifecycle 或消息无法投递活动。跨 bridge 需要 `wait`，不会唤醒目标。`timeout_ms` 默认为 30,000，取值为 0–60,000，`0` 只检查一次；下次调用带上各自返回的 cursor，取消工具调用即可停止等待。

`ThreadCreate` 默认启用，设置页的「权限 → 工具」可单独关闭，不影响另外 4 个线程工具。Peer 通信受 [`[thread_communication] enabled`](../configuration/config-files.md#thread-communication) 与持久化 workspace 覆盖控制。Bridge 入站另行默认关闭，由目标 owner 明确批准；关闭目标通信或入站会停止 bridge 投递，不删除会话。

只有来源 thread 的主 Agent 调用 `ThreadSend` 才会记录 peer 归属；REST 与 Klient 发送属于只指定目标的 user 来源输入。详见 [Agent 与子 Agent](../customization/agents.md#peer-thread-通信)。

Kiki 桌面端和 `kiki` CLI/TUI 会给主 `agent` profile 始终提供 `AgentRun`、`AgentList` 和 `AgentSend`。这些工具只管理调用方的直属子 Agent——用 `AgentRun` 里可选的 `name`，或用 agent id。它们不需要实验开关。内置的 [`coder` 与 `explore` profile](../customization/agents.md) 没有这组工具。

`AgentList` 返回这些直属子 Agent，不会列出孙级。`AgentSend` 的投递语义是尽早送达：子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn；子 Agent 空闲（或竞态恰逢 turn 结束）时保持排队，到下一步开始时才读这条消息。
协作类工具负责 Agent 间协作、用户交互和 Skill 调用。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `AgentRun` | 自动放行 | 派生 subagent 执行子任务，或继续一个直属子 Agent |
| `AgentList` | 自动放行 | 列出调用方的直属子 Agent |
| `AgentSend` | 自动放行 | 尽早向直属子 Agent 送达一条邮箱消息，运行中会被 steer 进活跃 turn |
| `AskUserQuestion` | 自动放行 | 向用户提问以获取结构化输入 |
| `Skill` | 自动放行 | 调用已注册的 inline Skill |

**`AgentRun`** 将子任务委托给子 Agent。必填参数为 `prompt` 和 `description`（3–5 个词的短任务描述，用于界面展示）。可选启动参数包括 `profile`（省略时由显式配置的 `[subagent].default_profile` 选择对应 profile；该配置键不存在时使用内建通用 subagent 提示词；显式留空时必须指定目标）、`profile_file`（显式 role Markdown 文件，绝对路径或工作区相对路径；它是 role 定义而非共享提示词模板，与 `profile`、`route`、`resume` 互斥）、`background`（省略时 main 默认后台、subagent 默认前台；显式 `false` 同步等待）、`name`（会话内唯一的句柄，只含小写字母、数字和下划线，`root` 保留）、`route`、`model_alias`、`effort`，以及在 `resume` 时显式修改模型用的 `allow_model_change`。另有两个可选参数按这一次绑定覆盖子 Agent 的工具：`tools` 替换已解析出的工具选择（只写 `*`，或写 `["*", ThreadRead]`，会保留普通工具并额外加入该 opt-in；有限名单仍然有限），`disallowed_tools` 增加一层调用级 deny。两者都省略时，新建子 Agent 使用配置默认，`resume` 保留已保存的覆盖；显式传值替换该层，`disallowed_tools: []` 只清掉调用级 deny，不会清除 profile、祖先或 route 的 deny。两者都要求原生 executor：不支持的外部 executor 会在子 Agent 启动前报错。新派生项按此顺序选模型：具体 `model_alias` 参数 → 生效 profile / route / caller lease pin → 显式配置的 `[subagent].default_model`。这些来源都不存在时以 `model.not_configured` 失败，不会创建子 Agent。调用方模型与主 Agent 的 `default_model` 均不是静默回退来源。`AgentRun` 拒绝 `model_alias: "inherit"`：请写具体的已配置模型名，或省略参数以使用目标默认模型。在 subagent profile、route、caller lease 中写 `model_alias: inherit`，仍会绑定调用方当前已解析的模型与有效思考强度；工具显式 `effort`，或 profile、route、lease、匹配的 `model_profiles` 条目上适用的 effort pin 优先。其他情况下，effort 按工具 `effort` → 匹配的 `model_profiles` 档位 → 所绑定模型与 profile pin 匹配时的 `thinking_effort` → 所绑定模型自身的默认档位解析。显式传入未知的具体 `model_alias` 会报错；main agent 没有调用方，其 profile 不可使用 `inherit`。`resume` 按名称或 agent id 继续已有直属子 Agent，与 `name`、`profile`、`profile_file` 和 `route` 互斥。同时省略 `model_alias` 和 `effort` 会保留已保存的绑定，也可以传入 `effort` 让下一次空闲运行使用。`AgentRun` 恢复时同样拒绝 `model_alias: "inherit"`；显式换模请写具体模型名。省略 `model_alias` 会保留已保存的模型；切换到不同规范模型必须传 `allow_model_change: true`，而解析到同一规范模型则不产生模型变化。`preferred_models`、`discouraged_models`、`preferred_efforts` 与 route / caller lease pin，对满足硬域且可执行的绑定产生 advisory。`allowed_models`、`deny_models`、`allowed_efforts` 在 profile、lease、树策略与匹配 model-profile 中为硬规则；绑定、人工切换与恢复均拒绝违规。机器级 deny、不可用能力、换模确认与 executor / thread 限制也仍是硬错误。外部 executor 不支持修改恢复的 thread 绑定时会报错，不会重建 thread 或 executor。Agent 任务默认 2 小时超时，通过 `[subagent] timeout_ms` 或 `KIKI_SUBAGENT_TIMEOUT_MS` 配置全局限制（`0` 表示禁用），print 模式默认无超时；不提供单次调用 timeout 或任意供应商参数透传。前台模式下父 Agent 等待结果；后台模式立即返回任务 ID，结果会通过之后的合成 User 消息自动送达。TUI 会把同一步中的多个前台调用合并展示，并显示状态与耗时。完整 profile 与生命周期契约见 [Agent 与子 Agent](../customization/agents.md)。

`AgentRun` 的默认值按调用方的运行时身份决定，不取决于目标 profile；每次 `resume` 重新应用同一规则，goal mode 也不改变默认值。Main 省略 `background` 或显式传 `true` 时，要求 `TaskList`、`TaskOutput`、`TaskStop` 可用；不可用则在启动前报错，提示启用这些工具或显式用 `background:false` 同步重试，不会静默回退到前台。Main 前台调用遇到 steer / Send now 时，等待会转入后台而不停止子 Agent；下一安全步骤读取新输入，子 Agent 完成后仍自动通知。普通排队消息不会触发转后台。停止当前 main 轮次不等于停止已脱离等待的子 Agent；需要停止某个跟踪任务时，显式调用 `TaskStop`。

体量较大的前台结果只返回尾部预览，而不是完整正文。回执会附带 `output_size_bytes`、`preview_bytes`、`truncated`、`full_output_available`，以及存在时的 `output_path`。有 `output_path` 时，用 `Read` 读取该文件取得完整结果，或用 `TaskOutput` 配合 `offset` 与 `max_bytes` 分页读取。没有完整输出文件时，`full_output_available` 为 `false`，只能读到预览：把工作拆成更小的片段，或用更窄的要求重新执行，让结果能被完整读回。结果较小时仍是普通摘要文本，不需要这一步。

[目标](../guides/goals.md)处于「阻塞（`blocked`）」时，完成结果仍会自动送达：主 Agent 会醒来处理这一次结果，目标保持阻塞。已暂停或取消的目标、以及预算耗尽，仍会把结果留到你的下一条消息。

**`AgentList`** 列出当前 Agent 的直属子 Agent。可选参数 `include_finished` 默认为 false。实例正在启动、运行或取消时，即使之前的后台任务已完成或超时，也会以 `running` 保持可见。执行器处于故障状态时显示 `errored`；其他情况采用最近一次后台任务状态，没有任务记录则为 `untracked`。传 `true` 才会额外包含已结束或出错的子 Agent。最多返回 50 条，运行中的排在前面；装不下的数量记在 `omitted`。每条记录含 `agent_id`、可选的 `name` 与 `profile`，以及 `status`。`running` 不代表一定有跟踪中的后台任务或之后的完成通知；用 `TaskList` 查看跟踪中的工作。

**`AgentSend`** 把非空的 `message` 排进直属子 Agent 的邮箱。`target` 可以是 `AgentRun` 当时传入的 `name`，也可以是 agent id。子 Agent 正在运行时，消息会在下一个 step 边界被 steer 进其活跃 turn，尽早送达；空闲且可恢复的子 Agent 会以该消息启动一次新的运行，该次运行完成时父 Agent 照常收到完成通知。匹配到多个直属子 Agent、或一个都匹配不到时调用失败——先用 `AgentList` 再换成不含糊的值重试。邮箱满了说明未读排队消息太多，等子 Agent 消化一些再发。

返回结果包含 `message_id` 和 `queued` 或 `delivered` 状态。`queued` 表示邮箱已接收，但消息尚未加入收件方上下文。收件方上下文持久化且邮箱确认投递后，发送者的 transcript 会记录投递回执，GUI 的「待送达」标记随之清除，即使没有打开子 Agent 的 transcript。回执在页面重载和历史回放后仍然有效；它只确认送达，不代表子 Agent 已按消息采取行动。

**`AskUserQuestion`** 以结构化多选题的形式向用户提问，适用于需要消歧或选择方案的场景。`questions` 参数接受 1–4 道题，每道题需提供 `question`（以 `?` 结尾）、`options`（2–4 个选项，每项含 `label` 和 `description`）以及可选的 `header`（最多 12 字符）和 `multi_select`（默认 false）。系统自动附加"其他"选项。`background` 为 true 时启动后台问题任务并立即返回任务 ID。宿主未实现交互式提问能力时返回失败提示，Agent 应改为在文本回复中直接提问。

**`Skill`** 按已注册的 `skill` 名称或显式 Markdown `path` 加载指令，两者互斥，可附带 `args`。路径可以是绝对路径或工作区相对路径，遵循文件读取权限和运行时隔离。路径加载不会覆盖已注册 Skill、安装插件或执行脚本。相对资源仍以文件所在目录为根；加载块记录来源路径与参数，可区分同名文件。省略类型以及 `prompt`、`inline` 类型均受支持；模型不能调用 `flow` 类型或 `disableModelInvocation: true` 的 Skill，路径入口也不例外。嵌套调用深度上限 3 层。Skill 体系细节见 [Agent Skills](../customization/skills.md)。

## 后台任务

完成通知会直接附上结果，并在可用时保留完整输出路径。同一模型步骤或同一轮恢复中的普通 Agent、进程预览共用 16,000 字节的 UTF-8 额度，在同批任务之间分配，按 XML 转义前的内容计算。单条结果可使用全部额度；有多条结果时，每条获得有界份额，不会被第一条独占。如果额度仍耗尽，通知会保留任务身份、状态、失败信息和可用的完整输出路径。完整问题回答保留原有的内联行为，不占用这个预览池。该限制针对预览，不是整个通知的总长度。

后台任务工具用于管理通过 `Bash`、`AgentRun` 或 `AskUserQuestion` 启动的后台任务。任务进入终止状态时会自动把状态和已保存的输出路径送回 Agent。对于启用自动完成通知的后台子 Agent，交互主 Agent（root）继续处理独立工作；没有独立工作时正常结束当前轮次。任务完成后，通知会在 root 空闲时自动开启后续轮次，无需用户再次发送消息。结束轮次会保留运行中的任务和会话，也不表示整体任务已完成。Agent 任务完成或被停止时，完成通知或 `TaskStop` 结果还会报告仍在运行的直属子 Agent：一个都不剩时不提示，最多列出 5 个名称，超出部分附上剩余数量。

Root 不应为了等待该结果，使用 `TaskWait`、`TaskOutput` 或 `AgentList` 轮询、sleep 或定时循环维持当前轮次。`TaskOutput` 用于有具体目的的进度检查，`TaskWait` 用于确需在同一轮次同步获取结果的场景。自动通知不可用时，按任务的实际需要选择是否等待。子 Agent 仍须处理自己的依赖，再向父 Agent 返回最终结果。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TaskList` | 自动放行 | 列出后台任务 |
| `TaskOutput` | 自动放行 | 查看后台任务的输出 |
| `TaskStop` | 需审批 | 停止正在运行的后台任务 |
| `TaskWait` | 自动放行 | 等待后台任务结束 |

**`TaskList`** 返回后台任务列表。可选参数包括 `active_only`（默认 true，仅列出运行中的任务）、`limit`（默认 20，范围 1–100）和 `offset`（默认 0）。只要 `has_more` 为 true，就把返回的 `next_offset` 传给下一页；任务列表在翻页期间发生变化可能导致位置移动。已完成的 subagent 条目包含回执元数据和 `receipt_verification`：只有 `verified` 回执可以作为完整结果；`contentState: unavailable` 不表示拿到了最终报告。`legacy_unverified` 和 `invalid` 不提供可信的回执路径。

**`TaskOutput`** 根据 `task_id` 返回任务状态与输出。省略分页参数时返回最近 32 KB 的预览；当 `full_output_available` 为 true 时，可传入 `offset: 0` 和可选的 `max_bytes`（范围 4–32768，默认 16384），并在 `has_more` 为 true 时继续使用 `next_offset`。偏移量按 UTF-8 字节计算，不是字符数；如果从字符中间开始，会跳到下一个完整字符，返回的 `offset` 表示实际起点。工具还会在完整日志可用时返回 `output_path`，也可使用 `Read` 查看。无效或未验证的终止任务回执不能作为完整输出分页读取。该调用始终非阻塞；任务完成会通过自动通知送达。

**`TaskStop`** 接受 `task_id` 和可选的 `reason`（默认 `Stopped by TaskStop`）。对已处于终止状态的任务也能安全调用。停止 Agent 任务会级联终止其各级子孙 subagent：每一层先停止自己子 Agent 的任务与执行（先深后浅），再中止该 Agent 本身，同时保留它们的可恢复 scope 与邮箱消息，供之后 resume。结果会报告停止后仍在运行的直属子 Agent（一个都不剩时不提示，最多 5 个名称）。

**`TaskWait`** 用于显式同步等待，把当前轮次挂起，直到后台任务结束或超时。参数：`timeout`（必填，有限正整数，单位秒，范围 1–86400），以及可选的 `task_id`、`sync_wait` 和 `sync_reason`。这个上限只约束本次等待，不延长任务运行时限或调用者的生命周期；任务结束、新输入或取消都可能提前结束等待。超时不是错误：结果会列出仍在运行的任务，不会停止它们。此时应重新判断同轮同步需求，不要自动重复等待。已通过 `TaskWait` 汇报结果的任务不会再推送自动完成通知。

非 active goal mode 下，main agent 等待运行中的 Agent 任务会立即收到可恢复错误，除非同时提供三个条件：`sync_wait: true`（默认 false）、明确的 `task_id`，以及非空且具体的 `sync_reason`，说明为什么必须在同一轮次获取结果。常规报告收集不是有效理由：应处理独立工作，或简要说明待完成状态后结束轮次，再按通知继续。拒绝等待不会停止任务，也不会消费其完成通知。subagent 等待自己的任务、main agent 等待进程任务，以及引擎已确认有 active goal 的 main agent，都不需要这些例外字段。已终止的任务会立即返回现有结果；同步例外不会增加任务所有权或可见范围。

不传 `task_id` 时，调用时刻运行中的任意一个后台任务结束即返回；当前没有运行中的后台任务时立即返回。非 active goal mode 下，main agent 的 wait-any（等待任一任务）快照只要包含运行中的 Agent 任务，就会被拒绝，不会静默过滤该任务。应指定明确的进程任务 ID，或对明确的 Agent 任务 ID 使用同步例外；`sync_wait` 不会豁免 wait-any 调用。

## 定时任务

定时任务工具允许 Agent 把一段 prompt 在未来某个时间重新注入到当前会话——既可以是一次性提醒，也可以是按 cron 周期触发的任务（定期巡检、每日报表、部署监控等）。计划绑定到会话，用 `kiki --session` 恢复会话后仍然有效，但不会带入全新的会话。单个会话最多保留 50 个生效中的定时任务。设置 `KIKI_DISABLE_CRON=1` 可整体禁用，详见[环境变量](../configuration/env-vars.md#运行时开关)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Cron`（`action: "create"`） | 需审批 | 安排一个在未来时刻触发的 prompt |
| `Cron`（`action: "list"`） | 自动放行 | 列出已安排的定时任务 |
| `Cron`（`action: "delete"`） | 需审批 | 取消已安排的定时任务 |

`Cron` 用 `action` 指定操作；旧名称 `CronCreate`、`CronList` 和 `CronDelete` 仍可被已有 profile 和审批规则引用，但不再作为单独的工具提供给模型。`action: "create"` 接受 `cron`（用户本地时区下标准的 5 段 cron 表达式：`minute hour day-of-month month day-of-week`）、`prompt`（触发时要注入的文本，UTF-8 上限 8 KB）以及可选的 `recurring`（默认 `true`；传 `false` 表示一次性提醒，触发后自动删除）。成功时返回 8 位 16 进制 `id`、人类可读的 `humanSchedule`（如 `every 5 minutes`）和 `nextFireAt`（下次触发时间的 ISO 时间戳）。

为避免整批用户在整点同时触发，调度器会做确定性抖动：周期任务向后偏移 `min(周期的 10%, 15 分钟)`；一次性任务若恰好落在 `:00` 或 `:30` 则向前提前最多 90 秒。如果调度器错过了若干触发时刻（如笔记本合盖），唤醒后只会触发一次，prompt 会包裹在 `<cron-fire>` 信封里并附带 `coalescedCount`。周期任务存活超过 7 天后会以 `stale="true"` 做最后一次触发后自动删除；想继续保留时，再次调用 `Cron` 的 `action: "create"` 即可。

**`Cron` 的 `action: "list"`** 是只读操作，除了 `action` 不需要其他参数。为每个生效中的任务返回一条记录，字段包括 `id`、`cron`、`humanSchedule`、`nextFireAt`、`recurring`、`ageDays` 和 `stale`。记录用 `---` 分隔，按调度时间排列。

**`Cron` 的 `action: "delete"`** 接受一个 `id`。对周期任务，未来所有触发立即停止；对一次性任务，挂起的那次触发会被取消。已触发的一次性任务会自动删除，因此删除已触发过的一次性任务会返回 `No cron job with id ...`。删除不可撤销，需要还原时只能再次执行 `action: "create"`。Plan 模式下此操作会被拦截。

报告成功的 `create` 或 `delete` 表示该变化已经落盘。保存本身失败时，工具返回错误且已存储的调度保持原样，因此成功回执不会对应一个只存在于内存中的任务。

## 目标

主 Agent 的 `Goal` 工具通过 `action: "create"`、`"get"`、`"set_budget"` 或 `"update"` 指定操作；旧名称 `CreateGoal`、`GetGoal`、`SetGoalBudget` 和 `UpdateGoal` 仍可供已有 profile 和审批规则使用，但不再作为独立工具公告。`create` 需要可验证的 `objective`，可附 `completionCriterion`；`replace: true` 仅在用户要求替换时放弃现有目标。`get` 查询状态。用户给出明确上限时，`set_budget` 接受正数 `value` 和单位（`turns`、`tokens`、`milliseconds`、`seconds`、`minutes`、`hours`）。`update` 将状态设为 `active`、`complete` 或 `blocked`；完成前须核实目标，非终局阻碍须连续三个目标轮次阻止推进。用户侧操作和示例见[目标](../guides/goals.md)。

## 下一步

- [Agent 与 subagent](../customization/agents.md) — `AgentRun` 工具的调度机制与上下文隔离
- [Hooks](../customization/hooks.md) — 在工具调用前后触发本地脚本
- [斜杠命令](./slash-commands.md) — TUI 内置控制命令速查
