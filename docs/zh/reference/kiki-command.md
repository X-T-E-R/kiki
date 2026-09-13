# `kiki` 命令

`kiki` 是统一 CLI 入口：交互式终端会话、非交互 `-p` 执行和共享 daemon 管理使用同一个命令。席位和 MCP 子命令供 Cursor、Claude Code、Codex 等外部调用方调用 Kiki（inbound），不负责配置 Kiki 用于运行 subagent 的外部执行器（outbound）。

## 启动或复用 daemon

以前台模式启动 daemon，或连接已有健康实例并在需要时启动一个新实例：

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki 按以下优先级解析 home 目录：支持该选项的命令中显式指定的 `--home`、`KIKI_HOME`、`~/.kiki`。运行时启动不读取旧 `KIMI_CODE_HOME` 设置。Daemon 共用 `<home>/server.token` 中的一份 bearer token。`--idle-exit` 默认是 `30m`；存在活跃客户端 lease 或运行中的派遣时，daemon 不会因空闲退出。客户端通过 `POST /api/leases` 续期 lease。

## 管理外部调用方席位

外部调用方连接前，席位会固定 workspace、principal、权限模式、模型和 thinking effort：

```sh
kiki seat create --workspace . --principal cursor --mode auto --json
kiki seat list --json
kiki seat revoke <seatId>
```

Daemon 为每组 workspace 和 principal 创建或复用一个席位。Delegation token 只由 `seat create` 返回；`seat list` 仅包含非敏感身份与配置字段。

## 安装 MCP 配置

为支持的客户端安装 stdio MCP 配置：

```sh
kiki seat install --client cursor --workspace .
kiki seat install --client claude --workspace .
kiki seat install --client codex --workspace .
kiki seat install --client generic --workspace .
```

Cursor 写入 `~/.cursor/mcp.json`；Claude Code 写入 workspace 下的 `.mcp.json`；Codex 打印 `config.toml` 片段；`generic` 打印 JSON。覆盖已有 `kiki` 条目前会先创建备份。

## 运行 stdio MCP 边

对于能够启动命令的 MCP 客户端，配置：

```sh
kiki mcp --workspace <dir>
```

该命令会确保 daemon 已运行，创建或复用 workspace 席位，并启动 MCP stdio 边。外部 MCP 调用方不能修改绑定的 workspace、权限模式、模型凭据、工具面或 profile 定义。

## 诊断连接

运行：

```sh
kiki doctor
```

报告会检查 daemon 可达性、token 文件路径与权限、席位列表，以及每个席位的权限模式。

## 从 `kimi` 迁移

安装后的统一入口为 `kiki`：不带子命令时进入 daemon 支持的 TUI，`kiki -p "提示词"` 继续使用既有非交互 memory 链路。Daemon、席位和 inbound 集成命令也在同一入口提供。不再安装 `kimi` bin，请同步更新命令启动器。

执行 `kiki migrate-config --json`，可将旧配置复制到 `KIKI_HOME` 或 `~/.kiki`。来源依次为 `--from <目录>`、旧 `KIMI_CODE_HOME` 设置、`~/.kimi-code`；只有这条显式迁移命令读取旧环境变量。使用 `--home <目录>` 可指定目标。解析 home 路径不会自动执行迁移。

Home 迁移复制 `config.toml`、`mcp.json`、`tui.toml`、`SYSTEM.md`、`AGENTS.md`、`region`、稳定的 OAuth `device_id`、供应商凭据 JSON，以及 `agents`、`commands`、`skills`、`themes` 目录树和其中的相对引用资源，不输出文件正文。目标中已有文件始终整份优先，不进行字段级合并，源文件不变。会话、daemon token、注册表或锁文件、缓存和日志不复制。自定义文件中的绝对引用不改写；确认这些引用和仍需保留的会话历史前，请勿删除源目录。

对每个项目执行 `kiki migrate-config --workspace <目录> --json`，将 `.kimi-code` 中的 `local.toml`、`AGENTS.md`、`mcp.json` 和上述自定义目录树复制到 `.kiki`。该选项不能与 `--from` 或 `--home` 合用。根 `AGENTS.md` 与标准 `.mcp.json` 保持不变，沿用既有语义和优先级。产品本地 MCP 仍属于选定的当前工作目录；嵌套目录有自己的旧 MCP 配置时，需单独迁移该目录。运行时只发现新的产品路径；存在未迁移的旧 local 配置时会提示迁移，不会静默读取。

文件系统操作失败后，修复提示的问题并重试，已复制文件会保留。迁移拒绝符号链接，不会跟随链接复制。若源目录中有未识别且目标中不存在的条目，结果为 `incomplete`，列出条目名称并以状态码 `2` 退出，不写完成标记。请检查并显式迁移这些资源后重试。只有选定文件处理完成且没有剩余未知条目时，才写入 `.kiki-config-migration-v2.json`；较早的 `.kiki-home-migration.json` 标记不会阻挡这次资源补迁。

桌面的兼容 home 只选择只读迁移来源，不再决定另一套运行时或 OAuth home。模型类别导入不复制凭据；依赖导入的认证引用前，请执行完整的 `migrate-config` 或重新登录。
