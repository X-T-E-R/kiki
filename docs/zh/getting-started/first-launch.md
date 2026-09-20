# 首次启动

本页承接安装之后的第一步：启动 Kiki、配置 API 来源，并完成第一次对话。

## 启动 Kiki

进入你的项目目录并运行 `kiki`，启动交互式界面：

```sh
cd your-project
kiki
```

从源码开发时，请在仓库根目录运行 `pnpm dev:cli`。要在不进入交互界面的情况下执行单条指令，使用 `-p`（prompt 模式）：

```sh
kiki -p "Take a look at this project's directory structure"
```

要恢复上一次会话，加上 `-c`（`--continue` 的短写；与 `--session` 等恢复方式的区别见[工作区与会话管理](../guides/sessions.md#启动与恢复会话)）：

```sh
kiki -c
```

## 配置 API 来源

首次启动需要配置 API 来源。在交互界面中输入 `/login` 开始登录流程：

```sh
/login
```

`/login` 打开平台选择器，支持两种方式：

- **Kimi Code（OAuth）** —— 设备码授权流程；在任意设备打开链接、登录并输入授权码
- **Kimi Platform API key** —— 输入来自 `platform.kimi.com` 或 `platform.kimi.ai` 的 API 密钥

要退出登录，输入 `/logout` 清除当前凭据。

::: tip 使用其他 AI 平台
如果想连接 Anthropic、OpenAI、Google 等平台，直接编辑 `~/.kiki/config.toml` 配置 API 密钥。详见[平台与模型](../configuration/providers.md)。全部配置项的完整参考见[配置文件](../configuration/config-files.md)、[环境变量](../configuration/env-vars.md)和[配置覆盖](../configuration/overrides.md)。
:::

## 你的第一次对话

登录后，用自然语言描述任务。一个不错的起点是让 Kiki 先熟悉项目：

```
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kiki 会自动调用文件读取、搜索等工具（工具是 Agent 可以调用的内置能力，例如读文件、搜索代码、运行命令）浏览相关内容，然后再回答。默认情况下，只读操作自动执行、无需确认；修改文件或运行 Shell 命令的操作会先请求你的确认。

也可以直接描述一个更具体的任务：

```
Add a function in src/utils that converts any string to kebab-case, and add a unit test for it.
```

Kiki 会规划步骤、修改代码、运行测试，并在每一步告诉你它做了什么。

::: tip 不知道该做什么？输入 `/help`
随时输入 `/help` 打开内置命令和快捷键面板。用 `↑`/`↓` 浏览，`Esc` 关闭。退出可以输入 `/exit`、空闲时连按两次 `Ctrl-C`，或在输入框为空时按 `Ctrl-D`。
:::

## 常用命令与快捷键

初次使用只需了解以下内容：

**会话命令**

| 命令 | 说明 |
| --- | --- |
| `/new` | 新建会话，清空当前上下文 |
| `/sessions` | 浏览会话历史并选择恢复 |
| `/model` | 切换当前模型 |
| `/compact` | 手动压缩上下文以释放 token（token 是模型计量文本的基本单位，一段话由多少 token 决定能装进多少上下文） |
| `/fork` | 将当前会话分叉为带完整历史的独立副本（你仍留在当前会话） |

**最常用快捷键**

| 快捷键 | 说明 |
| --- | --- |
| `Esc` | 中断流式输出（内容逐段实时显示的方式）/ 关闭弹窗 |
| `Ctrl-C` | 中断输出；空闲时按两次退出 |
| `Shift-Tab` | 切换 Plan 模式 |
| `Ctrl-S` | 在流式输出中途注入消息，无需等待当前响应结束 |
| `Ctrl-O` | 折叠 / 展开工具输出与压缩摘要（上下文压缩时自动生成的历史摘要） |

完整列表输入 `/help` 查看，或访问[斜杠命令](../reference/slash-commands.md)和[键盘快捷键](../reference/keyboard.md)。

## 数据存储在哪里

Kiki 默认将本地数据存放在 `~/.kiki/` —— 配置文件、会话记录、日志和更新缓存。要移到别处，通过 `KIKI_HOME` 环境变量指定新路径。完整目录布局见[数据路径](../configuration/data-locations.md)和[环境变量](../configuration/env-vars.md)。

## 下一步

- [交互与输入](../guides/interaction.md) —— 输入框操作、审批流程、Plan 模式与 YOLO 模式说明
- [工作区与会话管理](../guides/sessions.md) —— 恢复会话、任务看板、压缩上下文、导出会话
- [常见使用案例](./use-cases.md) —— 典型任务的提示词示例
