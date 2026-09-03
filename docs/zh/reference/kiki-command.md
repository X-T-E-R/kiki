# `kiki` 命令

`kiki` 命令管理共享的本地 daemon，供 Cursor、Claude Code、Codex 等外部调用方调用 Kiki（inbound）。它不配置 Kiki 用于运行 subagent 的外部执行器或外部 harness（outbound）。

## 启动或复用 daemon

以前台模式启动 daemon，或连接已有健康实例并在需要时启动一个新实例：

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

Kiki 按以下优先级解析 home 目录：`--home`、`KIKI_HOME`、兼容的 `KIMI_CODE_HOME` 设置、`~/.kiki`。Daemon 共用 `<home>/server.token` 中的一份 bearer token。`--idle-exit` 默认是 `30m`；存在活跃客户端 lease 或运行中的派遣时，daemon 不会因空闲退出。客户端通过 `POST /api/v1/leases` 续期 lease。

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

现有 `kimi` 命令仍是交互式 CLI 与 TUI 入口。交互式会话使用 [`kimi`](./kimi-command.md)，daemon、席位与外部调用方集成流程使用 `kiki`。
