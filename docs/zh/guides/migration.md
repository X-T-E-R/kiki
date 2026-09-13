# 从 kimi-cli 迁移

::: info
本页介绍从历史上的 Python/uv `kimi-cli` 安装迁移的路径。当前可执行文件是 `kiki`，运行时不会自动检测或静默迁移旧 home。
:::

如果仍保留旧 `kimi-cli` home 或较早的 Kimi Code home，请用 `kiki migrate-config` 显式迁移。只有这次操作会读取来源；正常运行 `kiki` 时只使用 `KIKI_HOME` 或 `~/.kiki`。

## 当前迁移契约

- 安装后的可执行文件是 `kiki`，不再安装旧的 `kimi` bin。
- 不带子命令运行 `kiki` 会启动 daemon 支持的 TUI；使用 `kiki -p "提示词"` 走 SDK 支持的非交互 memory 链路。
- 旧 home 和项目路径只作为迁移来源，运行时不会自动回退到这些路径。
- 桌面的兼容 home 同样只是只读迁移来源，不是第二套运行时或 OAuth home。

## 迁移 home

运行显式的 home 迁移命令：

```sh
kiki migrate-config --json
```

默认从 `~/.kimi-code` 复制到 `KIKI_HOME` 或 `~/.kiki`。如需指定其他来源或目标，显式传入：

```sh
kiki migrate-config --from /path/to/legacy-home --home /path/to/kiki-home --json
```

如果历史 `kimi-cli` 数据仍在 `~/.kimi/`，请传入 `--from ~/.kimi`；正常启动不会猜测这个路径。`KIMI_CODE_HOME` 只在这条显式迁移命令中作为来源接受。

迁移项目时，将旧的 `.kimi-code` 本地配置和自定义资源复制到 `.kiki`：

```sh
kiki migrate-config --workspace /path/to/project --json
```

`--workspace` 形式不能与 `--from` 或 `--home` 同时使用。

## 会复制什么

Home 迁移可以复制 `config.toml`、`mcp.json`、`tui.toml`、`SYSTEM.md`、`region`、稳定的 OAuth `device_id`、供应商凭据 JSON，以及 `agents`、`commands`、`skills`、`themes` 目录树和其中的相对引用资源。目标中已有文件始终整份优先，不进行字段级合并，也不会输出文件正文。

项目迁移会将旧 `.kimi-code/local.toml` 和项目自定义目录树复制到 `.kiki`。迁移完成后，运行时只发现新的 `.kiki` 路径。

## 什么会留在原处

会话、daemon token、注册表和锁文件、缓存与日志不会复制。自定义文件中的绝对引用不会改写；确认这些引用和仍需保留的会话历史前，请保留源目录。桌面的模型类别导入不会复制凭据；依赖导入的认证引用前，请执行完整的 `migrate-config` 或重新登录。

::: tip 提示
迁移不会修改或删除来源。目标中已有文件会保留；文件系统操作失败后，修复问题即可重试同一命令。迁移拒绝符号链接，不会跟随复制。如果源中仍有未知条目，命令会报告 `incomplete`、列出条目并以退出码 `2` 结束；请检查这些资源并重试，确认没有遗漏后再视为迁移完成。
:::
