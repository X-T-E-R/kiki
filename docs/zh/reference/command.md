# kiki 命令

`kiki` 是 Kiki 的命令行入口，提供交互式 TUI、非交互 `-p` 模式和共享 daemon 控制。无参数运行时在工作区信任后连接已有 daemon，不存在则启动；`kiki -p` 执行单条提示词后退出。显式管理 daemon 用 `kiki serve`，需要前台服务和浏览器界面时用 `kiki web`。席位和 MCP 子命令供 Cursor、Claude Code、Codex 等外部调用方调用 Kiki。

```sh
kiki [options]
kiki <subcommand> [options]
```

交互式会话始终使用共享后台服务（daemon）。确认工作目录可信后，CLI 会连接已有服务，或自动启动一个。失败时 Kiki 会直接显示错误，不会回退到另一个独立的本地会话——按错误提示排除问题后重新运行命令。

交互模式要求 stdin 和 stdout 都是终端。任一端接入管道或重定向时，运行会在触及工作区信任和 daemon 之前结束，Kiki 不会自动切换到非交互模式。需要从管道传入提示词时，用 `kiki -p -`，由 Kiki 从 stdin 读取。

## 主命令选项

所有 flag 都是可选的，直接运行 `kiki` 即可进入交互式会话：

| 选项 | 简写 | 说明 |
| --- | --- | --- |
| `--version` | `-V` | 打印版本号并退出 |
| `--help` | `-h` | 显示帮助信息并退出 |
| `--session [id]` | `-S` | 恢复一个会话。带 ID 时直接打开指定会话；不带 ID 时进入交互式选择器 |
| `--continue` | `-c` | 继续当前工作目录下最近一次的会话，无需手动指定 ID |
| `--model <model>` | `-m` | 为本次启动指定模型别名。省略时新会话使用配置文件中的 `default_model` |
| `--prompt <prompt>` | `-p` | 非交互执行单次 prompt，并把 Assistant 输出流式写到 stdout；传入 `-` 时从 stdin（程序的输入流）读取 |
| `--prompt-file <path>` | | 从 UTF-8 文件读取并执行一次 prompt，不能与 `--prompt` 同时使用 |
| `--output-format <format>` | | 设置非交互输出格式，支持 `text` 与 `stream-json`。仅在提供 prompt 时可用，默认 `text` |
| `--wait-for-session <seconds>` | | 在非交互模式中等待会话锁释放，超时后再失败 |
| `--timeout <seconds>` | | 限制整次非交互运行，包括提示词输入、启动、会话锁、模型调用及 goal/后台等待。接受正数秒（至少 `0.001`），默认不设整次期限；超时会取消活动 Agent 并使运行失败，有界清理可能额外耗时 |
| `--include-thinking` | | 在 `stream-json` 输出中包含 thinking 增量事件，默认关闭 |
| `--yolo` | `-y` | 自动批准普通工具调用，跳过审批请求 |
| `--auto` | | 以 Auto 权限模式启动；普通工具调用自动放行，受保护的操作和 Agent 提问仍可能询问你 |
| `--plan` | | 以 Plan 模式启动新会话，AI 会优先使用只读工具进行探索和规划 |
| `--skills-dir <dir>` | | 从指定目录加载 Skills，替换自动发现的用户和项目目录。可重复传入 |
| `--agent <name>` | | 以指定 Agent 作为 main agent 启动新会话。不能与 `--session`/`--continue` 同时使用 |
| `--agent-file <path>` | | 从 Markdown 文件加载自定义 Agent 并为新会话选中它。不可重复传入，也不能与 `--agent`、`--session` 或 `--continue` 同时使用 |
| `--add-dir <dir>` | | 为本次会话添加额外的工作目录。相对路径按当前工作目录解析。可重复传入 |

`-r` / `--resume` 是 `--session` 的隐藏别名；`--yes` 和 `--auto-approve` 是 `--yolo` 的隐藏别名，在帮助信息中不显示。

::: warning 注意
`--yolo` 会跳过普通工具调用的人工确认，包括文件写入和 Shell 命令执行，请只在受信任的工作目录下使用。Plan 模式的退出审批不会被 `--yolo` 跳过；Plan 模式下的 `Bash` 按普通放行规则处理。
:::

### flag 冲突规则

以下组合会在启动时被拒绝：

- `--continue` 与 `--session` 互斥——两者都表示"恢复历史会话"
- `--yolo` 和 `--auto` 互斥——两种权限模式互斥
- `--prompt` 与 `--prompt-file` 互斥，两者都不能与 `--yolo`、`--auto` 或 `--plan` 同时使用。非交互运行保留会话的权限模式，除非显式提供 `--permission-mode`；新会话在没有其他配置时默认使用 `auto`。恢复会话时的临时覆盖会在退出时还原。
- `--output-format` 需要同时提供 `--prompt` 或 `--prompt-file`

恢复会话时，可以通过 `--auto`、`--yolo` 或 `--plan` 覆盖原会话保存的权限或计划模式。例如，`kiki --continue --auto` 会恢复最近会话并切换到 auto 权限模式。

## 典型用法

直接运行开启新会话：

```sh
kiki
```

从上次中断的地方继续（自动找到当前目录最近的会话）：

```sh
kiki --continue
```

从历史会话列表中挑选，或直接指定已知 ID：

```sh
kiki --session
kiki --session 01HZ...XYZ
```

跳过审批确认，适合已知安全的批处理任务：

```sh
kiki --yolo
```

自动放行普通操作，同时保留受保护操作的审批：

```sh
kiki --auto
```

先阅读代码、产出实现计划，而不是立刻动手修改文件：

```sh
kiki --plan
```

### 自定义 Skills 目录

有两种方式指定 Skills 目录，语义不同：

- **`--skills-dir <dir>`**（CLI flag）：**替换**自动发现的用户和项目目录，仅对本次启动生效。可重复传入以叠加多个目录：

  ```sh
  kiki --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs`**（`config.toml`）：**叠加**到自动发现的目录之上，长期生效，适合配置团队共享 Skills。详见 [Agent Skills](../customization/skills.md)。

### 自定义 Agent

`--agent` 和 `--agent-file` 用于选择驱动新会话的 Agent，在 print 模式（`kiki -p`）和交互式 TUI 中均可使用：

```sh
kiki --agent reviewer
kiki -p --agent reviewer "审查这个分支上的改动"
```

`--agent-file` 以最高优先级注册单个 Agent 文件（仅本次启动）并选中它；该 flag 不可重复传入，`--agent` 与 `--agent-file` 互斥。两个 flag 都仅在新建会话时有效——都不能与 `--session`/`--continue` 组合，因为 Agent 在会话创建时绑定，恢复会话时会自动还原已绑定的 Agent。选择在会话首次绑定后即固定，之后不可切换；在 TUI 中，这些 flag 只绑定启动时的会话，之后在同一进程内新建的会话（例如通过 `/new`）使用默认 Agent。Agent 文件格式与发现目录详见 [Agent 与 subagent](../customization/agents.md#自定义-agent)。

## 非交互执行

在脚本或 CI 中运行单次 prompt 时，使用 `-p`：

```sh
kiki -p "Summarize the current repository status"
```

输出采用 transcript 样式：thinking 内容和 Assistant 正文都以 `• ` 开头，换行后两个空格缩进。Assistant 正文输出到 stdout；thinking、工具进度和"恢复会话"提示输出到 stderr。`-p` 模式不会请求人工审批，普通工具调用按 `auto` 权限策略处理，静态 deny 规则仍然生效。

临时切换模型：

```sh
kiki -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

多行提示词可以存入 UTF-8 文件，再用 `--prompt-file <path>` 读取；也可以将文件内容通过管道传给 `kiki -p -`。Windows 脚本若必须把多行内容作为命令行参数传入，请直接调用已安装的 `kiki.exe`：自动生成的 `kiki.cmd` 使用 `%*` 转发参数，在换行处会截断。`--prompt-file` 和 `-p -` 可以避开这个问题。

需要结构化读取输出时，使用 `stream-json` 格式——stdout 每行都是一个 JSON 对象：

```sh
kiki -p "List changed files" --output-format stream-json
```

`stream-json` 模式下，普通回复输出 Assistant 消息；模型调用工具时，先输出带 `tool_calls` 的 Assistant 消息，再输出对应的 Tool 消息，最后继续输出后续 Assistant 消息。thinking 内容默认省略；传入 `--include-thinking` 后，每个 thinking 增量会作为 `{"role":"assistant","type":"thinking.delta","content":"..."}` 写到 stdout。工具进度和恢复会话提示仍写到 stderr。

### 多个 print 进程共享一个 KIKI_HOME

多个 `kiki -p` 进程可以共享一个 `KIKI_HOME`，前提是每个进程使用不同的会话。Kiki 会串行化共享的 runtime owner 记录和会话索引写入，但每个会话仍然只允许一个活动写入者。不要同时对同一个会话运行两个 prompt；如果上一个进程应当很快释放会话，可以使用 `--wait-for-session <seconds>`。

Thread communication 默认关闭。不使用 thread 工具的 print 运行不会初始化 mailbox。启用 thread communication 时，可以设置 `KIKI_THREAD_MAILBOX_TIMEOUT_MS` 调整有界 mailbox 调用超时。print 模式会为本次运行中已经打开的会话自动触发定时任务，但不会扫描 home 中的其它会话，也不会唤醒未打开的会话；不属于本次运行的任务仍需通过交互式 daemon 或 server 运行。若需要最大程度的隔离，或每个 worker 都需要独立缓存和配置，请为每个 worker 使用独立的 `KIKI_HOME`。

## 子命令

`kiki` 提供以下子命令：`serve`（启动、复用或停止共享 daemon）、`seat`（管理外部调用方席位）、`mcp`（运行 stdio MCP 边）、`doctor`（诊断 daemon 连接）、`prompt-fields`（发现与校验提示词字段）、`login`（非交互式 OAuth 登录）、`acp`（ACP IDE 模式）、`web`（兼容的前台 REST/WebSocket/web 服务）、`export`（导出会话）和 `provider`（管理供应商）。

### `kiki serve`

显式控制共享 daemon。不带模式时，`serve` 在前台运行 daemon；`--query --json` 只报告当前实例，不启动服务；`--ensure` 连接已有健康实例，或启动一个新实例并返回连接信息；`--stop` 停止所选 home 下当前可达的实例。发现活跃实例却无法验证其身份时，Kiki 拒绝启动第二个实例：先停止或升级已有实例，再重试。

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki 按以下优先级解析 home 目录：支持该选项的命令中显式指定的 `--home`、`KIKI_HOME`、`~/.kiki`。可信本地客户端使用私有的 `<home>/server.local-owner` 凭据连接；远端连接使用独立凭据，见[鉴权](../server/local-server.md#鉴权)。`--idle-exit` 默认是 `30m`；活跃客户端 lease 和运行中的派遣会让 daemon 保持运行。设置 `--idle-exit 0ms` 后，新启动的 daemon 会持续运行到显式停止。客户端通过 `POST /api/leases` 续期 lease。交互式 TUI 在工作区信任后自动执行同样的连接或启动逻辑。需要兼容的前台服务和浏览器 UI 时，请用 [`kiki web`](#kiki-web)。

### `kiki connections`

管理 home 之间有方向的 GUI 连接。`--home` 选择本地源或提供方 home；管理操作使用其 local-owner 凭据。接收入站默认关闭，开启开关本身不会批准任何源。

```sh
kiki connections --home /path/to/source status
kiki connections --home /path/to/target inbound enable
kiki connections --home /path/to/target inbound invite --input source.json
kiki connections --home /path/to/source add --input connection.json
```

把源 `status` 返回的 `identity` 填入 `source.json`：`{ "source": { "homeId": "...", "hostId": "...", "protocol": 1 }, "label": "Source home" }`。目标会返回短时、一次性的 `invitation`。`connection.json` 包含 `label`、`endpoint`、以目标 `identity` 填写的 `target`、目标当前的 `ownerToken` 以及该 `invitation`；可用 `backgroundSummary` 开启轻量状态轮询。`homeId` 是标识 home 的 UUID，不是 GUI space ID。含秘密的文件应保持私有，成功配置后删除，不要把 token 放进命令参数。`--input -` 从 stdin（命令的标准输入通道）读取 JSON。

在目标运行 `inbound revoke <grantId>`，可停止一个源的读取和流，不影响其他已批准源。`inbound disable` 关闭所有 peer 访问并保留允许清单。在源使用 `disable <connectionId>`、`enable <connectionId>`、`retry <connectionId>` 和 `remove <connectionId>` 管理单个连接。移除只释放本地凭据和自有隧道，不停止目标 daemon，也不撤销已在目标开始的工作。离线状态保留最后测量值与时间戳，不编造零计数。

SSH 要求两端已安装兼容的 Kiki，源已配置可用的 SSH 登录与 known-host 校验。Kiki 不会安装远端软件。保存不含秘密的 profile，例如：

```json
{
  "id": "work-host", "label": "Work home",
  "target": { "kind": "alias", "alias": "work-host" },
  "releaseChannel": "stable", "remoteHome": "/home/example/.kiki",
  "remoteExecutable": "kiki", "remoteShell": "posix"
}
```

也可将 target 写成 `{ "kind": "host", "hostname": "example.com", "username": "example", "port": 22 }`；`identityFile` 可选。先生成计划，再核对返回的目标、身份和效果：

```sh
kiki connections --home /path/to/source ssh plan --input profile.json
kiki connections --home /path/to/source ssh execute PLAN_ID
kiki connections --home /path/to/source ssh execute PLAN_ID --ensure
kiki connections --home /path/to/source ssh register --input registration.json
kiki connections --home /path/to/source ssh status
```

计划只查询；不带 `--ensure` 的执行只连接已有服务。显式 `--ensure` 可启动远端 daemon，它会在后台持续运行到显式停止，不会顺带开放入站。GUI 登记的 `registration.json` 为 `{ "purpose": "gui", "planId": "PLAN_ID", "label": "Work home", "enableInbound": false, "backgroundSummary": true }`。`enableInbound: false` 时，目标入站关闭会如实报错；只有明确希望本次置备开启目标入站时才选择 `true`。仅供后端使用的 bootstrap 凭据会在置备后丢弃。`purpose: "bridge"` 只登记桥目标，另需 bridge policy 审批，不同时授予 GUI 访问。

### `kiki bridges`

管理显式单向 thread bridge，不授予 GUI 浏览权限。`--home` 选择执行端或提供端 home，管理始终使用其 local-owner 凭证。入站默认关闭：先启动目标 daemon，再用 `kiki connections --home <target-home> inbound enable` 明确开启入站；这不等于授权模型启动 turn。

```sh
kiki bridges --home /path/to/source status
kiki bridges --home /path/to/source local --input ./local-bridge.json
kiki bridges --home /path/to/source receipts --limit 50
kiki bridges --home /path/to/source outbound disable <bridgeId>
kiki bridges --home /path/to/provider inbound revoke <bridgeId>
```

`local` 读取 JSON，包含已登记本机空间的 `spaceId`、`sourceScope`、`targetScope`、`operations`、`expiresAt`（Unix 毫秒）、`label`，以及可选的 `pendingLimit`、`messagesPerMinute`。每个 scope 指定 `workspaceId`，通常还指定 `sessionId`；省略 Session 就明确允许该工作区的未来线程。分别选择 `read`、`send`、`wait`，只有允许目标接收模型 prompt 或恢复冷线程时才添加 `wake`。没有 wake 的消息保持 pending。本机目标使用稳定空间引用，daemon 换端口重启不会改变批准的 home。

Network 目标先用 `target --input <file>` 登记 `{label,endpoint,target}`，其中 target 为 `{homeId,hostId,protocol:1}`。在提供端，`approve --input <file>` 读取含来源与目标身份、scope、operation、expiry、label 及 `location: "network"` 的 policy，一次性输出 `{grant,credential}`。在来源端，`install --input <file>` 读取该结果加登记后的 `connectionId`。使用 HTTPS 或可信隧道；反向 bridge 需要另一条批准。GUI token 和 SSH 登录不授予 bridge 权限。

将 approve 输出和 install 输入作为凭证保护。所有 `--input` 都接受 `-`，从标准输入（程序读取输入的通道）读取 JSON；不要把 credential 放进终端参数或发给模型。`status` 和分页 `receipts` 不含凭证。Receipt 区分来源 pending、目标 accepted、prompt delivered 与拒绝；delivered 不代表模型已回复。Pending 保留原 key 和 sequence，最多重试 15 分钟。`retry` 检查持久队列，不新建消息。`inbound|outbound enable|disable|revoke <bridgeId>` 控制单条 link；入站 revision 改变后，需在来源端明确重新安装较新的 grant。撤销不删除会话。

[线程工具](./tools.md#协作类)使用这些策略并保留已验证的跨空间来源，不自动转发普通 Assistant 正文。危险鉴权绕过模式仍关闭 bridge 入站，也不绕过 bridge 管理鉴权。

### `kiki usage-export`

将一个本地 Kiki home 的无正文用量导出到 vibe-usage/vibecafe、标准 Webhook 或已批准脚本。命令无需实验开关即可使用；未配置或已禁用的目的端不发送任何数据。管理操作要求该 home 的本地所有者凭证；远程连接 token 和危险鉴权绕过模式都不授予此权限。

先保存草稿、查看准确范围和字段，再一次性批准这个目的端：

```sh
kiki usage-export --home /path/to/home save --input destination.json
kiki usage-export --home /path/to/home preview <id>
kiki usage-export --home /path/to/home test <id>
kiki usage-export --home /path/to/home enable <id> --fingerprint <preview_fingerprint> --agree
kiki usage-export --home /path/to/home sync <id>
kiki usage-export --home /path/to/home status
```

普通启用不要求先执行 `test`：它是单独的鉴权和接收协议检查，不发送用量。`preview` 不联系目的端。使用 `save` 返回的 `id` 和最近一次 `preview` 返回的指纹；改变目的端身份或扩大范围需要重新同意。显示的账号指纹只在本地标识这份凭据，不是已验证的远端账号身份。无法证明属于同一账号的新 key 需要重新同意；已有队列或交付后，应创建新目的端，而不是换掉旧目的端的身份。

Webhook 草稿示例：

```json
{
  "draft": {
    "label": "我的用量接收端",
    "target": { "kind": "webhook", "endpoint": "https://example.com/usage", "gzip": true, "authentication": "none" },
    "schedule_minutes": 30,
    "scope": { "start_at": 1767225600000, "end_at": null, "include_ephemeral": false, "excluded_workspace_ids": [] }
  }
}
```

时间使用 Unix 毫秒，桶按绝对 UTC 半小时划分。周期可选 `0`（手动）、`5`、`15`、`30`、`60` 分钟，附带抖动；只在后端存活时运行，不保活、不调用模型。临时/私密会话的用量默认排除，须明确选择。官方 `kiki.usage.bucket.v1` 只发送已知模型标识、四项互斥 token 数、质量和本地 USD 估价；未知价格为 `null`，未知本地别名使用目的端专属的不透明标识。不包含提示词、回复、推理、工具参数、附件、标题、工作区路径、profile 或真实主机名。接收端仍能观察 IP 地址和使用时段。

需要鉴权时，使用 `authentication: "bearer"` 或 `"hmac"`，并在 `draft` 旁添加 `secret`：`{ "value": "YOUR_SECRET", "storage": "keyring" }`。Keyring 失败会明确报错，不静默改存文件。要明确选择私有文件，设 `storage: "private-file"` 和 `acknowledge_file_storage: true`；文件系统权限保护它，但并未静态加密。所有 `--input` 都接受 `-` 从标准输入读入。保护凭证文件，不把 secret 放进终端参数或发给模型。Bearer 要求 HTTPS，不跟随重定向。本地开发 HTTP 须提供准确匹配 host、IP、port、protocol 的 `private_grant`，不是批准整个内网。

Vibe 目的端使用 `{ "kind": "vibe", "endpoint": "https://example.com/api/usage/ingest" }` 和实际服务的 key。Vibe 不支持删除，也不能可靠降低已接收总量：冲突修订会在发送前标为 `remote-diverged`，其他不冲突的新桶仍可继续。脚本使用 `{ "kind": "script", "command": "YOUR_COMMAND", "timeout_ms": 60000, "output_limit_bytes": 65536 }`。标准输入接收同一套无正文协议，标准输出须返回严格 receipt；测试时使用独立的 `kiki.usage.test.v1` 握手。同意后，命令拥有普通 OS 用户全部权限，能自行读文件、联网；这不是沙箱，也不会逐批请求批准。

恢复与移除具有不同含义：

- `disable <id>` 停止新请求、保留队列。`sync <id>` 按已有同意立即扫描并发送。临时网络故障保留同一持久批次身份并退避重试；协议或鉴权错误分别显示。
- `backfill <id> --input scope.json` 预览变更范围；扩大范围后用新指纹同意。`rebuild --force` 失效来源 checkpoint，包括同大小/mtime 改写；不修改 wire 事实、不清 ACK/版本历史。
- `diagnostics`、`export <id>`、`capacity <bytes>`、`retry <id>` 用于查看或恢复交付。默认队列上限为 50 MiB，满时保留旧的完整投影，不静默丢弃最旧数据。
- `clear-queue <id> --agree` 明确丢弃待发数据并停用该目的端。`remove <id>` 清除本地配置及其凭据；只有确实要丢弃现存队列时才添加 `--discard-pending`。两者都不删除远端历史，并保留必要的交付身份/版本依据。
- `withdraw <id> --agree` 仅向支持删除的接收端发送带版本的删除墓碑，不删除本地用量；vibe 不支持此操作。

已有 vibe collector 时，先在新原生草稿上执行 `handoff plan <id>`，再按返回的 namespace 和未来 UTC 截止 **T** 准备 collector 的 `kiki-handoff.json`，并执行原生 `preview`、`test`。

`handoff arm <id> --collector-file <file> --fingerprint <preview_fingerprint> --agree` 用已保存的原生凭据核对证明，激活该 home 的旧 collector 截止，并启用从固定 T 起的原生交付。它不读取旧 collector 的 key、不停止 daemon；不同 key 不会被当成同账号证明。

旧端负责 `<T`，原生负责 `>=T`，离线回补仍保留 T，不按 ACK 时间移动。`handoff refresh <id>` 读取旧端安全的最后回执；同时有旧回执和真实原生 ACK 才算完成。`handoff rollback <id> --cutoff <new_future_R> --agree` 保留原生负责 `[T,R)`，旧端从 `>=R` 恢复，而不是无界重扫旧历史。

接收端开发者可在仓库中运行 `pnpm exec tsx packages/kap-server/examples/usage-export-receiver.ts`（Node 24）。示例只监听 `127.0.0.1:9080`，在 `usage-receiver.sqlite` 持久保存替换版本和删除墓碑，提供 `POST /usage`。测试时须批准准确的 loopback HTTP grant。生产接收端应提供 TLS、持久存储和鉴权；示例不是托管看板。

### `kiki agents` 与委派命令

`kiki agents --json` 读取工作区的有效智能体档目录，返回 `items` 和 `complete`，不创建对话，也不注册工作区。使用 `--workspace <目录>` 查看其他目录。

`kiki dispatch <message>` 在启动工作时创建或复用 CLI 委派席位。其他委派命令，包括 `list`、`interactions`、`status`、`wait`、`result`、`events` 和 `transcript`，要求已有席位；没有席位时返回退出码 `3`，不会新建。先通过 `dispatch` 启动工作，或使用 `--principal kiki-cli` 显式创建席位，再使用这些命令。

### `kiki seat`

管理 Cursor、Claude Code、Codex 等外部 MCP 调用方使用的固定席位。外部调用方连接前，席位会固定 workspace、principal、权限模式、模型和 thinking effort：

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

Daemon 为每组 workspace 和 principal 创建或复用一个席位。Delegation token 只由 `seat create` 返回；`seat list` 仅包含非敏感身份与配置字段。

#### 安装 MCP 配置

为支持的客户端安装 stdio MCP 配置：

```sh
kiki seat install --client cursor --workspace .
kiki seat install --client claude --workspace .
kiki seat install --client codex --workspace .
kiki seat install --client generic --workspace .
```

Cursor 写入 `~/.cursor/mcp.json`；Claude Code 写入 workspace 下的 `.mcp.json`；Codex 打印 `config.toml` 片段；`generic` 打印 JSON。覆盖已有 `kiki` 条目前会先创建备份。

### `kiki mcp`

为外部调用方运行 stdio MCP 边。命令会确保共享 daemon 已运行，创建或复用该工作区席位，并启动 MCP stdio 边：

```sh
kiki mcp --workspace <目录>
```

外部 MCP 调用方不能修改绑定的 workspace、权限模式、模型凭据、工具面或 profile 定义。

### `kiki doctor`

诊断本地 Kiki 连接，不会启动 TUI，也不会修改文件。它会检查 daemon 是否可达、当前 home 的 token 路径与权限、服务端身份以及外部调用方席位列表和每个席位的权限模式。默认使用 `KIKI_HOME` 或 `~/.kiki`；如需检查其他 home，可传入 `--home`。报告默认即以 JSON 输出（`--json` 为保留的显式写法，输出相同），也不会启动服务；需要先创建服务时，先运行 `kiki serve` 或 `kiki serve --ensure`。需要校验 `config.toml`、`tui.toml` 与 Agent profile 时，改用 `kiki doctor --agents`（或子命令形式 `kiki doctor agents`），它以可读文本输出结果。

```sh
kiki doctor
kiki doctor --home /path/to/kiki --json
```

报告包含：

- `daemon`：健康 daemon 是否可达；可达时还包含 URL 和 server ID
- `token`：token 路径、是否存在、文件模式以及权限是否安全
- `seats`：不含敏感信息的席位 ID、principal、workspace 和权限模式

### `kiki prompt-fields`

`kiki prompt-fields` 是用于发现提示词字段、校验字段配置和解释运行时上下文中生效值的只读操作面；它不会修改 `config.toml`、`SYSTEM.md`、Agent profile 或外部覆写文件。

**列出字段**——`list` 输出所有已注册字段及其 owner、consumer 和覆写策略：

```sh
kiki prompt-fields list
```

**查看字段**——`show` 输出单个字段的默认模板、空值策略、允许变量和必需占位符：

```sh
kiki prompt-fields show system.language
```

**校验配置**——`validate` 校验所选配置中的提示词覆写、引用的外部 TOML 文件、`SYSTEM.md` 和发现到的 Agent profile：

```sh
kiki prompt-fields validate --config ./candidate.toml --home ~/.kiki
```

**解释有效值**——`explain` 输出所选上下文中字段的 `effective`、`shadowed` 或 `inactive` 状态、有效值及完整来源链：

```sh
kiki prompt-fields explain delegation.sub.notice --agent reviewer --model fast --executor native --delegation-position sub
```

使用 `--agent <名称>`、`--model <alias>`、`--executor <id>` 和 `--delegation-position <main|sub|independent>` 选择解释上下文。使用 `--config <路径>` 检查另一份配置文件，使用 `--home <目录>` 选择读取 `SYSTEM.md`、发现 Agent 以及解析相对外部覆写文件时所用的 Kiki home。不带子命令的 `kiki prompt-fields` 等同于 `list`。

已移除的 `prompt.shared` 与 `prompt.tools` 键已迁入 `[prompt.overrides]` 下的字段；请按 [提示词字段优先级](../configuration/overrides.md#提示词字段优先级) 迁移旧条目，不要恢复旧键。

### `kiki login`

通过 RFC 8628 device-code 流程登录 Kimi Code OAuth，无需进入 TUI。命令会发起一次 device authorization 请求，将验证地址和用户码打印到 stderr，然后轮询直到浏览器侧完成授权。生成的 token 写入与 TUI `/login` 相同的本地位置，下次启动 `kiki` 时会自动加载。

```sh
kiki login
```

该子命令没有任何 flag。在轮询期间随时按 `Ctrl-C` 可取消登录；取消或失败时退出码为 `1`，成功为 `0`。

### `kiki acp`

把 Kiki 切换到 ACP（Agent Client Protocol）模式，在标准输入/输出上以 JSON-RPC 形式与 IDE 对话，让编辑器直接驱动 kiki 的会话和工具调用。通常不需要手动运行——IDE 会把它作为子进程入口启动。配置方式见[在 IDE 中使用](../server/ide.md)，技术细节见 [kiki acp 参考](../server/acp.md)。

```sh
kiki acp
```

默认不允许客户端提交 stdio MCP 服务器。若要信任 IDE 在 Kiki 用户账户下启动本地 MCP 进程、且不再单独触发 `Bash` 审批，请将 IDE 配置为使用 `kiki acp --allow-client-stdio-mcp`。详见 [MCP 转发](../server/acp.md#mcp-转发)。

### `kiki web`

在当前终端前台运行本地 Kiki 服务 —— 同一个进程同时挂载 REST + WebSocket API 与 Kiki GUI —— 并在服务就绪后用默认浏览器打开 Kiki GUI。命令会一直挂在终端，直到收到 `SIGINT` / `SIGTERM`（如 `Ctrl-C`）时干净退出。

服务运行时，`GET /openapi.json` 会返回 REST OpenAPI 文档，`GET /asyncapi.json` 会返回本地 WebSocket 协议的 AsyncAPI 文档。用 API 驱动会话的完整流程见[本地服务与 API](../server/local-server.md)，协议细节见[服务 API](../server/rest-api.md)。

```sh
kiki web                 # 前台运行服务并打开浏览器
kiki web --no-open       # 不打开浏览器
kiki web --port 58628    # 指定绑定端口
```

同一 home 目录下可以同时运行多个实例：每个实例注册到 `~/.kiki/server/instances/`，端口被占用时自动 +1 重试（58628、58629……）。

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 绑定端口；默认 `58627`；被占用时自动 +1 重试 |
| `--host [host]` | 绑定地址；缺省 `127.0.0.1`（仅本机）。绑定非本机地址（包括裸 `--host`，即 `0.0.0.0`）需要有终结 TLS 的反向代理，或加 `--insecure-no-tls`；两者都没有时服务拒绝启动 |
| `--insecure-no-tls` | 允许不带终结 TLS 的反向代理绑定非本机地址；此时该地址上的连接不加密 |
| `--allowed-host <host...>` | DNS 重绑定检查额外允许的 Host 头，可重复或逗号分隔 |
| `--log-level <level>` | 按所选级别开启服务日志；默认不输出 |
| `--debug-endpoints` | 挂载 `/api/debug/*` 调试路由（默认关闭） |
| `--dangerous-bypass-auth` | 关闭所有 REST 与 WebSocket 路由的 bearer token 鉴权，使 Kiki GUI 无需 token 即可连接；仅用于可信网络或自有鉴权代理之后 |
| `--no-open` | 就绪后不自动打开浏览器 |
| `--idle-exit <duration>` | 没有 GUI lease 或忙碌会话持续达到此时长后退出；接受整数加 `ms`、`s`、`m` 或 `h`（如 `30m`）。默认不设置，前台服务会持续运行 |

`kiki web` 默认只绑定本机 loopback 地址，并在启动横幅中打印 bearer token；Kiki GUI 通过 URL 的 `#token=` 片段自动完成鉴权。

`kiki web` 同时承载 Web 访问控制——`--temporary`、`--persistent`、`--status`、`--off`、`--revoke [session-id]`——用于把这台 Kiki 开放给另一台设备的浏览器，并打印一次性进入链接。Web 访问是对这台 Kiki 的完整访问入口，不是只读分享；会话与撤销模型见[在浏览器里使用 Kiki](../server/local-server.md#在浏览器里使用-kiki)。同样的操作在交互式 TUI 中是 `/web temporary|persistent|status|off|link|revoke [id]`，在 GUI 中位于**设置 → 空间 → Web 访问**。

::: info 提示
`kiki web` 是兼容性的前台命令：它在当前进程中启动独立服务，不会连接或管理共享 daemon。需要控制共享 daemon 的生命周期时使用 `kiki serve`；需要已有前台 REST/WebSocket/web UI 流程时使用 `kiki web`。旧的 `kiki server …` 命令已不再支持。
:::

::: danger 警告
`--dangerous-bypass-auth` 会免鉴权暴露旧 API：任何能访问该端口的人都能控制会话、文件和 shell。连接管理与转发仍要求 local-owner；有效 peer 准入不可用，保存的 grant 也不能在此模式授权入站 peer。仅在可信网络或自有鉴权反向代理之后使用，用完后停止服务。
:::

#### `kiki web rotate-token`

替换 `<home>/server.token` 中持久化的远端 owner token。旧 token 失效，受影响的 peer 流停止；运行中的实例无需重启即可发现变化。这不会轮换 `server.local-owner` 中的私有本地管理凭据。远端源须更新凭据后才能重新连接。

### `kiki export`

把一个会话打包成 ZIP 文件，便于分享、归档或提交问题反馈。

```sh
kiki export [sessionId] [options]
```

| 参数 / 选项 | 简写 | 说明 |
| --- | --- | --- |
| `sessionId` | | 要导出的会话 ID。省略时自动选择当前工作目录下最近一次的会话，并要求确认 |
| `--output <path>` | `-o` | 输出 ZIP 文件路径。省略时写入当前目录下的默认文件名 |
| `--yes` | `-y` | 跳过默认会话的确认提示，直接导出 |
| `--no-include-global-log` | | 不打包全局诊断日志。默认包含 |

导出包含目标会话目录内的所有文件。全局诊断日志（`~/.kiki/logs/kimi-code.log`）默认包含，因为它可能含有其他会话或项目的事件；不想分享时加 `--no-include-global-log`。

```sh
# 导出当前工作目录最近一次会话，跳过确认
kiki export -y

# 导出指定会话到自定义路径
kiki export 01HZ...XYZ -o ./bug-report.zip

# 排除全局诊断日志
kiki export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kiki provider`

在 shell 中管理供应商，相当于 TUI 中 `/provider` 的非交互版本。适合脚本化部署、CI 初始化，以及在新机器上一行完成配置。

```sh
kiki provider <action> [options]
```

包含五个动作：

#### `kiki provider add <url>`

从自定义 registry（`api.json`）批量导入所有供应商。本次显式命令会拉取 registry，为每个条目创建 `[providers.<id>]` 和 `[models.<alias>]`，并在 `source` 元数据中记录 registry。后续启动不会同步 registry；手动获取模型只会为已有提供商返回未保存的建议，详见[获取模型建议](../configuration/providers.md#获取模型建议)。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<url>` | Registry 地址 |
| `--api-key <key>` | 访问 registry 时携带的 Bearer token。必填：未传时回退到环境变量 `KIKI_REGISTRY_API_KEY`，两者都未提供时命令报错退出 |

```sh
kiki provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# 或通过环境变量（适合 CI / .envrc）
KIKI_REGISTRY_API_KEY=YOUR_KEY kiki provider add https://registry.example.com/v1/models/api.json
```

如果某个 provider id 已存在，会先删除再重新写入。不会自动设置默认模型，后续可用 `-m` 或 TUI 内的 `/model` 选择。

#### `kiki provider remove <providerId>`

删除指定供应商及其所有模型 alias。如果被删除的供应商正好是 `default_model` 所属，则同时清空 `default_model`。

```sh
kiki provider remove kohub
```

#### `kiki provider list`

按行打印每个已配置的供应商，含类型、模型数量、来源。加 `--json` 可输出原始的 `providers` 和 `models` 表，便于程序化处理。

```sh
kiki provider list
kiki provider list --json | jq '.providers | keys'
```

#### `kiki provider catalog list [providerId]`

在不修改任何配置的情况下浏览公开的 [models.dev](https://models.dev/) 模型目录。不传参数时列出所有供应商及协议类型和模型数量；传 `providerId` 时列出该供应商下所有模型的上下文窗口和能力。目录地址不可达时会使用内置目录快照。

| 参数 / 选项 | 说明 |
| --- | --- |
| `[providerId]` | 可选，要查看的供应商 id |
| `--filter <substring>` | 按 id 或 name 大小写不敏感子串过滤 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json` |
| `--json` | 以 JSON 形式输出匹配片段 |

```sh
kiki provider catalog list
kiki provider catalog list --filter anthropic
kiki provider catalog list anthropic
```

#### `kiki provider catalog add <providerId>`

按 id 从 catalog 直接导入一个已知供应商，协议类型、base URL、模型信息均由 catalog 提供，只需提供 API key。catalog 未声明协议的供应商（如 xai、openrouter 这类厂商专用 SDK）按 OpenAI 兼容协议导入，并在输出中标注 "guessed"；catalog 未提供可用端点时需用 `--base-url` 显式指定。专有协议（如 Amazon Bedrock）无法导入。公共目录不可达时会回退到内置目录快照，离线或网络受限环境下也能导入。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<providerId>` | catalog 中的供应商 id，如 `anthropic`、`openai` |
| `--api-key <key>` | 供应商 API key。必填：未传时回退到 `KIKI_REGISTRY_API_KEY`，两者都未提供时命令报错退出 |
| `--default-model <modelId>` | 可选，导入后把 `default_model` 设为 `<providerId>/<modelId>` |
| `--base-url <url>` | 覆盖 catalog 声明的端点；catalog 未提供端点（或仅有环境变量占位符）时必填 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json` |

```sh
kiki provider catalog list anthropic          # 先看可选的模型
kiki provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## 下一步

- [斜杠命令](./slash-commands.md) — 交互式 TUI 内的控制命令速查
- [键盘快捷键](../reference/keyboard.md) — 终端与界面快捷键速查
- [内置工具](../reference/tools.md) — 工具与权限清单
- [配置文件](../configuration/config-files.md) — `default_model`、权限模式等启动参数的持久化配置
- [在 IDE 中使用](../server/ide.md) — 编辑器与 IDE 集成
- [Agent Skills](../customization/skills.md) — `--skills-dir` 加载的 Skill 文件格式
- [Agent 与 subagent](../customization/agents.md) — 内置 subagent、自定义 Agent 文件与通过 `--agent` 选择 main agent
