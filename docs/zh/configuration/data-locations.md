# 数据路径

Kiki 默认把运行时数据——配置文件、会话历史、登录凭据、诊断日志——存放在 `~/.kiki/` 下。本页帮你搞清楚每类数据在哪里、用来做什么，以及需要时怎么清理或搬迁。

::: warning 桌面 OAuth 凭据的默认位置不同
未设置 `KIKI_HOME` 时，桌面应用的运行时数据（配置、会话、`server.token`）在 `~/.kiki/`，但它的 OAuth 凭据默认在兼容家目录 `~/.kimi-code/`（`~/.kimi-code/credentials/`）。如果本机已有 Moonshot 的 `~/.kimi-code/credentials/kimi-code.json`，桌面会直接使用这份令牌，而不是处于未登录状态——并且删除 `~/.kiki/` **不会**清掉它。先跑 `kiki login` 则令牌写在 `~/.kiki/credentials/`，之后不带桌面环境变量启动的 daemon 找不到桌面那边的令牌。

设置 `KIKI_HOME` 会把运行时数据和桌面 OAuth 凭据一起挪到该路径。桌面设置里也可以自行选择兼容家目录。kimi-cli 时代的 `~/.kimi` 目录从不被读取，也不会被导入。
:::

## 数据根目录

默认数据根是 `~/.kiki/`，在不同平台的实际路径：

- macOS：`/Users/<name>/.kiki`
- Linux：`/home/<name>/.kiki`
- Windows：`C:\Users\<name>\.kiki`

如果你需要把数据目录挪到别处（比如用多个独立环境隔离不同项目的配置），设置 `KIKI_HOME` 即可：

```sh
export KIKI_HOME="$HOME/.config/kiki"
```

设置后，配置、供应商凭证、会话、日志、OAuth 凭据、Kiki 专属用户级 Skills、全局 `AGENTS.md` 等 **Kiki 数据**都会落到新路径下。`KIKI_HOME` 的完整说明见[环境变量](./env-vars.md)。

::: tip 提示

**通用 `.agents` 资源**仍放在真实 OS home 下，以便跨工具共享。例如，用户级通用 Skills 仍位于 `~/.agents/skills/`，而 Kiki 专属用户级 Skills 会随 `KIKI_HOME` 移动到 `$KIKI_HOME/skills/`。
:::

## 目录结构

```text
$KIKI_HOME  （默认 ~/.kiki）
├── config.toml             # 用户配置
├── credentials.toml        # 供应商凭证（仅属主可读写，0600）
├── tui.toml                # 终端界面偏好
├── AGENTS.md               # 全局 Kiki 专属 Agent 指令（可选）
├── mcp.json                # 用户级 MCP server 声明（可选）
├── skills/                 # Kiki 专属用户级 Skills（可选）
├── cognition/              # `[models."<alias>".cognition]` 引用的提示词文件（可选；见配置文件页）
├── hooks/                  # `[[hooks]]` command 路径引用的脚本文件（可选；见 Hooks）
├── plugins/
│   ├── installed.json      # 已安装 plugin 记录与启用状态
│   └── managed/            # zip/本地路径安装的 plugin 副本
├── session_index.jsonl     # 会话索引
├── workspaces.json          # 已注册工作区的名称与根目录
├── workspaces/              # 自动创建的工作区目录
│   └── <date>-<id>/
├── credentials/            # OAuth 凭据（目录 0700，文件 0600；与 credentials.toml 不同）
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # 会话数据（详见下文）
│   └── <workDirKey>/<sessionId>/
├── bin/
│   ├── rg                  # Grep 使用的托管 ripgrep 二进制（Windows 为 rg.exe）
│   └── fd                  # 文件引用使用的托管 fd 二进制（Windows 为 fd.exe）
├── logs/
│   └── kimi-code.log       # 全局诊断日志
└── user-history/
    └── <md5(workDir)>.jsonl
```

## 各类文件说明

数据根下的顶层文件各有用途，大部分由 CLI 自动管理：

- **`config.toml`**：主运行时配置，存放供应商、模型、循环控制等用户级设置。它不会保存明文凭证——供应商 API 密钥放在配套的 `credentials.toml` 里。详见[配置文件](./config-files.md)。
- **`credentials.toml`**：`config.toml` 的配套文件，存放供应商凭证，例如各供应商的 `api_key`。同一条 TOML 路径上这里的值覆盖 `config.toml`；旧版 `config.toml` 里遗留的凭证会在首次加载时迁入该文件，原文件保留为 `config.toml.bak-<date>`。在平台支持的前提下，Kiki 以仅属主可读写的权限（`0o600`）写入该文件。详见[供应商凭证](./config-files.md#供应商凭证)。
- **`tui.toml`**：终端界面客户端偏好，例如主题、编辑器、通知和状态栏。
- **`AGENTS.md`**：用户级 Agent 指令。该文件会随 `KIKI_HOME` 移动，并与工作区根目录指令合并；工作区的 `.kiki/AGENTS.md` 可以覆盖它。
- **`mcp.json`**：用户级 MCP server 声明，启动时与项目内的 `.kiki/mcp.json` 合并加载。详见 [MCP](../server/mcp.md)。
- **`skills/`**：Kiki 专属用户级 Skills。该目录会随 `KIKI_HOME` 移动；跨工具通用 Skills 仍可放在 `~/.agents/skills/`。详见 [Agent Skills](../customization/skills.md)。
- **`cognition/`**：`[models."<alias>".cognition]` 引用的提示词文件，路径相对于数据根目录。详见[模型认知](./config-files.md#模型认知)。
- **`hooks/`**：`[[hooks]]` command 路径引用的脚本文件（如 `node ~/.kiki/hooks/check-bash.mjs`）。详见 [Hooks](../customization/hooks.md)。
- **`plugins/installed.json`**：记录已安装的 plugin、每个 plugin 的启用状态，以及通过 `/plugins` 或 `/plugins mcp disable|enable` 修改的 MCP server 能力状态。本地路径和 zip URL 安装的文件会复制到 `plugins/managed/<id>/`。详见 [Plugins](../customization/plugins.md)。
- **`credentials/`**：OAuth 凭据目录——与上面的 `credentials.toml` 文件不同——权限 `0o700`（目录）/ `0o600`（文件），仅当前用户可读写。托管供应商的 OAuth 登录态存为 `credentials/<name>.json`，MCP server 凭据存在 `credentials/mcp/` 子目录下。凭据写入使用原子流程（tmp → fsync → rename）防止写损。
- **`workspaces.json` 与 `workspaces/`**：分别记录已注册工作区，以及新会话未指定工作区时 Kiki 创建的项目目录。每个自动创建的会话使用独立目录；这里是工作文件，与 `sessions/` 下的会话历史不同。

## 会话数据

每个会话的数据存在 `sessions/<workDirKey>/<sessionId>/` 下，同时在顶层 `session_index.jsonl` 里维护一份索引（每行一条记录，含 `sessionId`、`sessionDir`、`workDir` 三个字段）。`workDirKey` 是从工作目录路径生成的桶名，格式为 `wd_<slug>_<sha256前12位>`。

会话目录内部包含：

- **`state.json`**：会话标题、`lastPrompt`、创建/更新时间、`forkedFrom` 等元数据。
- **`upcoming-goals.json`**：由 `/goal next <objective>` 创建的 TUI 专属队列。它不属于 Agent 对话；只有当前目标完成并提升后续目标后，才会进入 Agent 对话。
- **`agents/main/wire.jsonl`**：main agent 的完整通信记录，用于会话恢复和回放。
- **`agents/main/plans/`**：Plan 模式下写入的计划文件，按计划 id 命名（`<id>.md`）。
- **`agents/agent-0/` 等**：subagent 实例目录，各自含 `wire.jsonl`。
- **`logs/kimi-code.log`**：该会话的诊断日志，只有发生诊断事件时才存在。
- **`tasks/`**：后台任务持久化——`tasks/<task_id>.json` 保存状态/pid/退出码，`tasks/<task_id>/output.log` 保存输出。
- **`cron/`**：定时任务持久化，用 `kiki --session` 恢复会话时重新加载到调度器。详见[定时任务](../reference/tools.md#定时任务)。

## 内置工具缓存

`Grep` 工具第一次需要 ripgrep 时，CLI 可自动下载 `rg` 并缓存到 `bin/rg`（Windows 为 `bin/rg.exe`）。终端界面的文件引用补全使用 `fd`；需要时 CLI 会在后台自动下载并缓存到 `bin/fd`（Windows 为 `bin/fd.exe`）。之后的运行会直接复用缓存的二进制。`rg` 优先使用系统 `PATH`，再使用缓存；`fd` 优先检查托管缓存，再回退到系统 `fd` / `fdfind`。删除 `bin/` 目录会在下次需要时触发重新下载。

## 日志

日志文件名 `kimi-code.log` 沿用自 Kiki 上游项目的历史命名，保持不变。

- **`logs/kimi-code.log`**（全局）：记录启动、登录、导出等跨会话事件。
- **`<sessionDir>/logs/kimi-code.log`**（会话级）：记录单个会话内的诊断事件。

报 bug 时，优先用 `kiki export` 导出相关会话（详见 [kiki 命令](../reference/command.md)）；会话日志默认包含在导出包里。不想分享全局日志时加 `--no-include-global-log`。

## 输入历史

终端输入历史按工作目录分开保存，路径为 `user-history/<md5(workDir)>.jsonl`。用于在终端界面里用方向键浏览历史提示词。

## 清理数据

删除数据根目录（`~/.kiki/` 或 `KIKI_HOME` 指定路径）会清除所有运行时数据，**包括自动创建的工作区中的文件**。删除前请备份这些工作文件。归档会话或注销工作区不会删除工作目录；只清理 `sessions/` 也不会删除 `workspaces/`。未设置 `KIKI_HOME` 且桌面兼容家目录保持默认时，桌面 OAuth 凭据在 `~/.kimi-code/credentials/`（见本页开头的说明），删除 `~/.kiki/` **不会**清掉它。只需清理部分内容时：

| 需求 | 操作 |
| --- | --- |
| 重置配置 | 删除 `~/.kiki/config.toml` |
| 重置供应商凭证 | 删除 `~/.kiki/credentials.toml` |
| 重置终端界面偏好 | 删除 `~/.kiki/tui.toml` |
| 清理所有会话 | 删除 `~/.kiki/sessions/` 和 `session_index.jsonl` |
| 清理诊断日志 | 删除 `~/.kiki/logs/` |
| 清理输入历史 | 删除 `~/.kiki/user-history/` |
| 强制重新下载托管 `rg` 和 `fd` | 删除 `~/.kiki/bin/` |
| 清除供应商 OAuth 登录态 | 运行 `/logout`，或删除对应的 `credentials/<name>.json` |
| 清除 MCP server OAuth 登录态 | 删除 `credentials/mcp/`（`/logout` 不会清理 MCP 凭据） |
| 移除用户级 MCP 声明 | 删除 `$KIKI_HOME/mcp.json`（默认为 `~/.kiki/mcp.json`） |
| 清理全局 Kiki 专属 Agent 指令 | 删除 `$KIKI_HOME/AGENTS.md`（默认为 `~/.kiki/AGENTS.md`） |
| 清理 plugin 安装记录 | 删除 `$KIKI_HOME/plugins/`（本地 plugin 源码不受影响） |
| 清空 Kiki 专属用户级 Skills | 删除 `$KIKI_HOME/skills/`（默认为 `~/.kiki/skills/`） |

## 下一步

- [配置文件](./config-files.md) — `config.toml` 各字段的完整说明
- [环境变量](./env-vars.md) — `KIKI_HOME` 等路径变量的详细用法
